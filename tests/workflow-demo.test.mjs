import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createPythonDemoWorker, workflowDemoMiddleware } from '../server/workflow-demo.mjs';

async function request(middleware, {
  method = 'POST', path = '/api/demo/workflow', body = { action: 'reserve' },
  contentType = 'application/json', origin,
} = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = path;
  req.headers = { host: '127.0.0.1:5173', 'content-type': contentType, ...(origin ? { origin } : {}) };
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = text => { res.body = JSON.parse(text); res.writableEnded = true; };
  const next = vi.fn();
  const result = middleware(req, res, next);
  req.end(typeof body === 'string' ? body : JSON.stringify(body));
  await result;
  return { status: res.status, headers: res.headers, body: res.body, next };
}

function fakeMiddleware() {
  const worker = { request: vi.fn(async () => ({ ok: true, snapshot: { fixture: true } })), close: vi.fn() };
  const factory = vi.fn(() => worker);
  return { middleware: workflowDemoMiddleware({ workerFactory: factory }), worker, factory };
}

describe('local workflow demo transport', () => {
  it('keeps unrelated APIs untouched and starts no Python worker', async () => {
    const { middleware, factory } = fakeMiddleware();
    const response = await request(middleware, { path: '/api/procurement/status', method: 'GET' });
    expect(response.next).toHaveBeenCalledOnce();
    expect(factory).not.toHaveBeenCalled();
  });

  it('reads state and forwards approved action shapes to one worker', async () => {
    const { middleware, worker, factory } = fakeMiddleware();
    const state = await request(middleware, { method: 'GET' });
    const action = await request(middleware, { body: { action: 'approve', key: 'owner-click-1' } });
    expect(state.body.ok).toBe(true);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(action.status).toBe(200);
    expect(factory).toHaveBeenCalledOnce();
    expect(worker.request.mock.calls.map(call => call[0])).toEqual([{ action: 'snapshot' }, { action: 'approve', key: 'owner-click-1' }]);
    middleware.close();
    expect(worker.close).toHaveBeenCalledOnce();
  });

  it.each([
    [{ method: 'DELETE' }, 405],
    [{ contentType: 'text/plain' }, 415],
    [{ contentType: 'application/json-wrong' }, 415],
    [{ origin: 'http://another-site.example' }, 403],
    [{ body: '{invalid' }, 400],
    [{ body: 'x'.repeat(4097) }, 413],
    [{ body: { action: 'reserve', business_id: 'B' } }, 400],
    [{ body: { action: 'approve', owner_id: 'another-owner' } }, 400],
    [{ body: { action: 'unknown' } }, 400],
    [{ body: { action: 'snapshot' } }, 400],
    [{ body: { action: 'reserve', key: '' } }, 400],
    [{ body: { action: 'reserve', key: 'x'.repeat(129) } }, 400],
    [{ body: [] }, 400],
  ])('rejects invalid requests before starting a worker: %j', async (options, status) => {
    const { middleware, factory } = fakeMiddleware();
    expect((await request(middleware, options)).status).toBe(status);
    expect(factory).not.toHaveBeenCalled();
  });

  it('serializes competing requests before sending them to Python', async () => {
    let release;
    const first = new Promise(resolve => { release = resolve; });
    const worker = {
      request: vi.fn().mockImplementationOnce(() => first).mockResolvedValue({ ok: true, snapshot: {} }),
      close: vi.fn(),
    };
    const middleware = workflowDemoMiddleware({ workerFactory: () => worker });
    const created = request(middleware, { body: { action: 'create_order' } });
    const reserved = request(middleware, { body: { action: 'reserve' } });
    await vi.waitFor(() => expect(worker.request).toHaveBeenCalledTimes(1));
    release({ ok: true, snapshot: {} });
    await Promise.all([created, reserved]);
    expect(worker.request.mock.calls.map(call => call[0].action)).toEqual(['create_order', 'reserve']);
    middleware.close();
  });

  it('returns domain rejection without treating it as a transport failure', async () => {
    const { middleware, worker } = fakeMiddleware();
    worker.request.mockResolvedValue({ ok: false, error: 'All lines must be fully reserved before fulfillment', snapshot: { stock: { on_hand: 13 } } });
    const response = await request(middleware, { body: { action: 'fulfill' } });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(false);
    expect(response.body.snapshot.stock.on_hand).toBe(13);
    middleware.close();
  });

  it('does not expose local paths or stack traces on unexpected worker errors', async () => {
    const { middleware, worker } = fakeMiddleware();
    worker.request.mockRejectedValue(new Error('/private/home/secret.py: failed'));
    const response = await request(middleware);
    expect(response.status).toBe(503);
    expect(response.body.error).toContain('Restart');
    expect(JSON.stringify(response.body)).not.toContain('secret.py');
    middleware.close();
  });

  it('cannot start a new session after server shutdown', async () => {
    const { middleware, factory } = fakeMiddleware();
    middleware.close();
    expect((await request(middleware, { method: 'GET' })).status).toBe(503);
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('actual Python worker, synthetic fixtures only', () => {
  it('preserves state across commands and replays actual domain operations', async () => {
    const worker = createPythonDemoWorker();
    try {
      const commands = ['create_order', 'reserve', 'compare', 'approve', 'receive_x'];
      for (const action of commands) expect((await worker.request({ action })).ok).toBe(true);
      const rejected = await worker.request({ action: 'fulfill' });
      expect(rejected.ok).toBe(false);
      expect(rejected.snapshot.stock.on_hand).toBe(13);
      expect((await worker.request({ action: 'receive_y' })).snapshot.order.status).toBe('ready');
      const fulfilled = await worker.request({ action: 'fulfill' });
      expect(fulfilled.snapshot.stock).toEqual({ on_hand: 2, reserved: 2, available: 0 });
      expect((await worker.request({ action: 'replay' })).snapshot.stock).toEqual(fulfilled.snapshot.stock);
      expect((await worker.request({ action: 'check_isolation' })).ok).toBe(true);
    } finally {
      worker.close();
    }
  });

  it('reports missing Python as a local setup error', async () => {
    const worker = createPythonDemoWorker({ python: '/nonexistent/demo-python' });
    try {
      await expect(worker.request({ action: 'snapshot' })).rejects.toThrow('Python could not start');
    } finally {
      worker.close();
    }
  });

  it('cancels requests that have not been sent to the worker', async () => {
    const worker = createPythonDemoWorker();
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(worker.request({ action: 'create_order' }, { signal: controller.signal })).rejects.toThrow('cancelled');
      const state = await worker.request({ action: 'snapshot' });
      expect(state.snapshot.order).toBeNull();
    } finally {
      worker.close();
    }
  });
});

describe('Baseten workflow bridge', () => {
  function aiSetup(run) {
    const state = {
      source: 'ai', order: { id: 'customer-order', created_at: '2026-10-21T12:00:00Z' },
      item: { name: 'Industrial filter' }, deadline: '2026-11-01', budget_cents: 2000,
      suppliers: ['X', 'Y', 'Z'].map(id => ({ id, name: `Supplier ${id}` })),
      lines: [{ id: 'customer-order:1', shortage: { quantity_to_purchase: 11 } }], recommendation: null,
    };
    const worker = { request: vi.fn(async command => command.action === 'prepare_ai'
      ? { ok: true, snapshot: state } : { ok: true, snapshot: { ...state, applied: command.estimates } }), close: vi.fn() };
    const service = { run: vi.fn(run), close: vi.fn() };
    const estimatesFactory = vi.fn(() => service);
    return { middleware: workflowDemoMiddleware({ workerFactory: () => worker, estimatesFactory }), worker, service, estimatesFactory, state };
  }

  function estimates() {
    return {
      provenance: { kind: 'ai_estimate', model: 'test-model', generatedAt: '2026-10-21T12:00:00Z', expiresAt: '2026-10-28T12:00:00Z', cached: true },
      assumptions: ['All-in linear unit prices; hypothetical suppliers.'],
      quotes: ['X', 'Y', 'Z'].map((id, index) => ({ supplierId: id, items: [{ availableQuantity: [7, 4, 0][index], price: { kind: 'unit', cents: 100 }, expectedDate: '2026-10-25' }] })),
    };
  }

  it('constructs the shortage request on the server and forwards price basis and provenance', async () => {
    const { middleware, worker, service, estimatesFactory } = aiSetup(async () => estimates());
    const response = await request(middleware, { body: { action: 'compare_ai' } });
    expect(response.status).toBe(200);
    expect(estimatesFactory).toHaveBeenCalledWith(['X', 'Y', 'Z'].map(id => ({ id, name: `Supplier ${id}` })));
    expect(service.run.mock.calls[0][0].request.items[0]).toMatchObject({ quantity: 11, name: 'Industrial filter' });
    expect(worker.request.mock.calls[1][0]).toMatchObject({ action: 'apply_ai', estimates: {
      provenance: { cached: true, model: 'test-model' }, quotes: [{ supplier_id: 'X', quantity_priced: 11, capacity_quantity: 7, price_cents: 100, currency: 'USD' }, expect.anything(), expect.anything()],
    } });
    expect(worker.request.mock.calls.every(([value]) => value.action !== 'approve')).toBe(true);
    middleware.close();
    expect(service.close).toHaveBeenCalledOnce();
  });

  it('never requests a model when Python rejects the state or a plan already exists', async () => {
    const { middleware, worker, service } = aiSetup(async () => estimates());
    worker.request.mockResolvedValue({ ok: false, error: 'Reserve first', snapshot: {} });
    expect((await request(middleware, { body: { action: 'compare_ai' } })).body.ok).toBe(false);
    worker.request.mockResolvedValue({ ok: true, snapshot: { recommendation: { feasible: true } } });
    await request(middleware, { body: { action: 'compare_ai' } });
    expect(service.run).not.toHaveBeenCalled();
    middleware.close();
  });

  it('reports provider failure without substituting sample quotes', async () => {
    const { middleware, worker } = aiSetup(async () => { throw Object.assign(new Error('Baseten is unavailable'), { status: 503 }); });
    const response = await request(middleware, { body: { action: 'compare_ai' } });
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('Baseten is unavailable');
    expect(worker.request).toHaveBeenCalledTimes(1);
    middleware.close();
  });

  it('rejects total-price lots instead of silently prorating a price', async () => {
    const value = estimates();
    value.quotes[0].items[0].price.kind = 'total';
    const { middleware, worker } = aiSetup(async () => value);
    expect((await request(middleware, { body: { action: 'compare_ai' } })).status).toBe(503);
    expect(worker.request).toHaveBeenCalledTimes(1);
    middleware.close();
  });

  it.each([
    { action: 'apply_ai', estimates: {} },
    { action: 'compare_ai', estimates: {} },
    { action: 'create_order', budget_cents: true },
    { action: 'create_order', budget_cents: -1 },
    { action: 'receive', supplier_id: 'outside-company' },
  ])('rejects untrusted estimate and command fields: %j', async body => {
    const { middleware, factory } = fakeMiddleware();
    expect((await request(middleware, { body })).status).toBe(400);
    expect(factory).not.toHaveBeenCalled();
    middleware.close();
  });
});
