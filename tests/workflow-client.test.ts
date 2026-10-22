import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot, sendAction, type Snapshot } from '../src/workflow-client';

function snapshot(): Snapshot {
  return {
    mode: 'in_memory', supplier_data: 'synthetic',
    company: { id: 'A', name: 'Company A', currency: 'USD', owner_id: 'companyAOwner' },
    scenario: { quantity: 15 },
    suppliers: [
      { id: 'supplier-x', name: 'Supplier X', capacity_quantity: 7, quantity_priced: 7, unit_price_cents: 100, expected_date: '2026-10-25' },
      { id: 'supplier-y', name: 'Supplier Y', capacity_quantity: 4, quantity_priced: 4, unit_price_cents: 125, expected_date: '2026-10-26' },
    ],
    clock: '2026-10-21T12:00:00Z', deadline: '2026-10-28', budget_cents: 2000,
    item: { id: 'item', name: 'Industrial filter', sku: 'FLT-001' },
    stock: { on_hand: 6, reserved: 2, available: 4 },
    other_order: { id: 'other-order', reserved_quantity: 2 },
    order: null, lines: [], quotes: [], recommendation: null, purchases: [], events: [],
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('workflow demo client', () => {
  it('loads the current Python snapshot without a browser cache', async () => {
    const value = snapshot();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, snapshot: value })));
    vi.stubGlobal('fetch', fetcher);
    await expect(getSnapshot()).resolves.toEqual(value);
    expect(fetcher).toHaveBeenCalledWith('/api/demo/workflow', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal),
    }));
  });

  it('forwards the caller operation key without inventing a new one', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, snapshot: snapshot() })));
    vi.stubGlobal('fetch', fetcher);
    await sendAction('approve', 'owner-approval-1');
    await sendAction('compare');
    const options = fetcher.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1]);
    expect(JSON.parse(String(options[0].body))).toEqual({ action: 'approve', key: 'owner-approval-1' });
    expect(JSON.parse(String(options[1].body))).toEqual({ action: 'compare' });
    expect(options[0].method).toBe('POST');
    expect(options[0].headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
  });

  it('returns a rejected domain action with its unchanged snapshot', async () => {
    const value = snapshot();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: false, error: 'Order is not ready.', snapshot: value })));
    await expect(sendAction('fulfill', 'fulfill-too-early')).resolves.toEqual({
      ok: false, error: 'Order is not ready.', snapshot: value,
    });
  });

  it('reports HTTP errors with a bounded server message', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: `Unavailable ${'x'.repeat(1000)}` }), { status: 503 }));
    const error = await getSnapshot().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: 'WorkflowError', code: 'http_error' });
    expect((error as Error).message.length).toBeLessThanOrEqual(240);
  });

  it('explains an HTML response from a server without the demo route', async () => {
    vi.stubGlobal('fetch', async () => new Response('<!doctype html><title>LogisticsNerd</title>'));
    await expect(getSnapshot()).rejects.toMatchObject({
      code: 'invalid_response', message: expect.stringContaining('npm run dev'),
    });
  });

  it('reports a non-JSON HTTP failure without exposing its HTML', async () => {
    vi.stubGlobal('fetch', async () => new Response('<h1>Bad gateway</h1>', { status: 502 }));
    await expect(getSnapshot()).rejects.toMatchObject({
      code: 'http_error', message: expect.stringContaining('HTTP 502'),
    });
  });

  it('rejects a response that cannot supply the workflow view', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, snapshot: { ...snapshot(), stock: null } })));
    await expect(getSnapshot()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('reports a stopped local server without substituting fixture data', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    await expect(getSnapshot()).rejects.toMatchObject({
      code: 'connection_failed', message: expect.stringContaining('npm run dev'),
    });
  });

  it('bounds the time spent waiting for a stalled demo process', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const assertion = expect(getSnapshot()).rejects.toMatchObject({ code: 'request_timeout' });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
  });
});

describe('AI workflow client', () => {
  it('accepts empty AI supplier previews and forwards explicit budget and receipt choices', async () => {
    const value: Snapshot = { ...snapshot(), source: 'ai', supplier_data: 'ai_estimate', estimate_provenance: null,
      suppliers: ['X', 'Y', 'Z'].map(id => ({ id, name: `Supplier ${id}`, capacity_quantity: null, quantity_priced: null, unit_price_cents: null, expected_date: null })) };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, snapshot: value })));
    vi.stubGlobal('fetch', fetcher);
    await expect(getSnapshot()).resolves.toEqual(value);
    await sendAction('create_order', undefined, { budget_cents: 15000 });
    await sendAction('receive', undefined, { supplier_id: 'Z' });
    expect(JSON.parse(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ action: 'create_order', budget_cents: 15000 });
    expect(JSON.parse(String((fetcher.mock.calls[2] as unknown as [string, RequestInit])[1].body))).toEqual({ action: 'receive', supplier_id: 'Z' });
  });

  it('rejects malformed provenance before displaying AI terms', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, snapshot: { ...snapshot(), estimate_provenance: { kind: 'ai_estimate' } } })));
    await expect(getSnapshot()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
