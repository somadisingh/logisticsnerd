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
