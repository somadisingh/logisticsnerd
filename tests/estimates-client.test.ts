import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockQuotes, requestFromDraft, sampleDraft } from '../src/data';
import { estimateStatus, generateEstimates, validateEstimateResponse } from '../src/estimates-client';

const request = requestFromDraft(sampleDraft());
const selectedSuppliers = request.selectedSupplierIds.map((id) => ({ id, name: id }));

function payload() {
  return {
    quotes: mockQuotes(request),
    comparisons: { lowest_cost: { recommendedSupplierIds: ['untrusted'] }, earliest_delivery: {} },
    provenance: { kind: 'ai_estimate', model: 'example/model', generatedAt: '2026-10-03T12:00:00Z', cached: false },
    assumptions: ['Hypothetical standard-quality goods, domestic US delivery.'],
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('estimate response boundary', () => {
  it('recomputes cheapest and fastest from the same validated facts', () => {
    const result = validateEstimateResponse(payload(), request);
    expect(result.comparisons.lowest_cost.recommendedSupplierIds).toEqual(['metro']);
    expect(result.comparisons.earliest_delivery.recommendedSupplierIds).toEqual(['comfort']);
  });

  it('accepts a valid comparison with no feasible supplier', () => {
    const impossibleRequest = { ...request, maxBudgetCents: 1 };
    const result = validateEstimateResponse(payload(), impossibleRequest);
    expect(result.comparisons.lowest_cost.outcome).toBe('no_feasible_quote');
    expect(result.comparisons.earliest_delivery.recommendedSupplierIds).toEqual([]);
  });

  it.each([
    ['missing supplier', (value: ReturnType<typeof payload>) => { value.quotes.pop(); }],
    ['unselected supplier', (value: ReturnType<typeof payload>) => { value.quotes[0].supplierId = 'invented'; }],
    ['duplicate supplier', (value: ReturnType<typeof payload>) => { value.quotes[1].supplierId = value.quotes[0].supplierId; }],
    ['different request', (value: ReturnType<typeof payload>) => { value.quotes[0].requestId = 'stale-request'; }],
    ['different item', (value: ReturnType<typeof payload>) => { value.quotes[0].items[0].requestedItemId = 'stale-item'; }],
    ['invalid calendar date', (value: ReturnType<typeof payload>) => { value.quotes[0].items[0].expectedDate = '2026-02-30'; }],
    ['fractional money', (value: ReturnType<typeof payload>) => { value.quotes[0].items[0].price.cents = 10.1; }],
    ['negative stock', (value: ReturnType<typeof payload>) => { value.quotes[0].items[0].availableQuantity = -1; }],
    ['unbounded model text', (value: ReturnType<typeof payload>) => { value.assumptions[0] = 'x'.repeat(1001); }],
  ])('rejects %s instead of populating the UI', (_name, mutate) => {
    const value = payload();
    mutate(value);
    expect(() => validateEstimateResponse(value, request)).toThrow('did not pass our checks');
  });

  it('rejects non-object output without exposing internal parsing errors', () => {
    expect(() => validateEstimateResponse(null, request)).toThrow('did not pass our checks');
    expect(() => validateEstimateResponse({ quotes: [null] }, request)).toThrow('did not pass our checks');
  });
});

describe('local estimate API client', () => {
  it('sends one batch to our server without credentials', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(payload()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/procurement/estimates');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(options.body))).toEqual({ request, suppliers: selectedSuppliers, preference: 'lowest_cost' });
    expect(result.quotes).toHaveLength(request.selectedSupplierIds.length);
  });

  it('shows a clarification from a 422 response', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'Ambiguous item.', code: 'needs_clarification', clarification: 'What size of box do you need?' }), { status: 422 }));
    await expect(generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal))
      .rejects.toMatchObject({ message: 'What size of box do you need?', code: 'needs_clarification' });
  });

  it('reports an unavailable service without substituting sample data', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Network error'); });
    await expect(generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal))
      .rejects.toMatchObject({ code: 'connection_failed' });
  });

  it('keeps cancellation distinct so a stale request cannot display an error', async () => {
    vi.stubGlobal('fetch', (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const controller = new AbortController();
    const pending = generateEstimates(request, selectedSuppliers, 'lowest_cost', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('bounds total waiting time', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const assertion = expect(generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal))
      .rejects.toMatchObject({ code: 'request_timeout' });
    await vi.advanceTimersByTimeAsync(65000);
    await assertion;
  });

  it('uses configuration status without generating an estimate', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ configured: true })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await estimateStatus()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/procurement/status');
  });
});
