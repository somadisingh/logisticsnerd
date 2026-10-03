import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockQuotes, requestFromDraft, sampleDraft } from '../src/data';
import { createEstimateClient, estimateStatus, validateEstimateResponse } from '../src/estimates-client';
import type { ProcurementRequest } from '../src/domain/model';

const request = requestFromDraft(sampleDraft());
const selectedSuppliers = request.selectedSupplierIds.map((id) => ({ id, name: id }));
const generatedAt = Date.parse('2026-10-03T12:00:00Z');

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

  it('accepts an older valid as-of date and rejects invalid calendar provenance', () => {
    const valid = { ...payload(), provenance: { ...payload().provenance, asOfDate: '2026-10-02' } };
    expect(validateEstimateResponse(valid, request).provenance.asOfDate).toBe('2026-10-02');
    for (const asOfDate of ['2026-02-30', 'October 3', 123]) {
      expect(() => validateEstimateResponse({ ...valid, provenance: { ...valid.provenance, asOfDate } }, request)).toThrow('did not pass our checks');
    }
  });
});

describe('local estimate API client', () => {
  let generateEstimates: ReturnType<typeof createEstimateClient>['generateEstimates'];
  beforeEach(() => { generateEstimates = createEstimateClient({ now: () => generatedAt }).generateEstimates; });
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

describe('browser estimate cache', () => {
  function setup(options: { ttlMs?: number; maxEntries?: number } = {}) {
    let timestamp = generatedAt;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as { request: ProcurementRequest };
      const value = payload();
      value.provenance.generatedAt = new Date(timestamp).toISOString();
      value.quotes = value.quotes.filter((quote) => sent.request.selectedSupplierIds.includes(quote.supplierId)).map((quote) => ({
        ...quote, requestId: sent.request.id, items: quote.items.map((item) => ({ ...item, requestedItemId: sent.request.items[0].id })),
      }));
      return new Response(JSON.stringify(value));
    });
    const client = createEstimateClient({ fetcher: fetchMock, now: () => timestamp, ...options });
    const generate = (input = request, suppliers = selectedSuppliers, preference: 'lowest_cost' | 'earliest_delivery' = 'lowest_cost', signal = new AbortController().signal) =>
      client.generateEstimates(input, suppliers, preference, signal);
    return { fetchMock, generate, advance: (milliseconds: number) => { timestamp += milliseconds; }, setTime: (value: number) => { timestamp = value; } };
  }

  it('reuses one generation for cheapest and fastest, and recomputes changed budget/deadline against the same offers', async () => {
    const { generate, fetchMock } = setup();
    const first = await generate();
    const fast = await generate(request, selectedSuppliers, 'earliest_delivery');
    const stricter = { ...request, id: 'new-request', maxBudgetCents: 1, items: [{ ...request.items[0], id: 'new-item', requiredDate: '2026-10-04' }] };
    const changed = await generate(stricter);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.provenance.cached).toBe(false);
    expect(fast.provenance.cached).toBe(true);
    expect(fast.comparisons.earliest_delivery.recommendedSupplierIds).toEqual(['comfort']);
    expect(changed.comparisons.lowest_cost.outcome).toBe('no_feasible_quote');
    expect(changed.comparisons.earliest_delivery.outcome).toBe('no_feasible_quote');
    expect(changed.quotes.every((quote) => quote.requestId === 'new-request' && quote.items[0].requestedItemId === 'new-item')).toBe(true);
    expect(changed.quotes.map((quote) => quote.id)).not.toEqual(first.quotes.map((quote) => quote.id));
    expect(changed.comparisons.lowest_cost.evaluations.every((evaluation) => evaluation.rejections.some((rejection) => rejection.code === 'budget'))).toBe(true);
  });

  it('canonicalizes item/unit whitespace and casing, supplier names, and supplier order', async () => {
    const { generate, fetchMock } = setup();
    await generate();
    const equivalent = {
      ...request, selectedSupplierIds: [...request.selectedSupplierIds].reverse(),
      items: [{ ...request.items[0], name: `  ${request.items[0].name.toUpperCase().replace(/ /g, '   ')}  `, unitLabel: ` ${request.items[0].unitLabel?.toUpperCase()} ` }],
    };
    const result = await generate(equivalent, selectedSuppliers.map((supplier) => ({ ...supplier, name: ` ${supplier.name.toUpperCase()} ` })).reverse());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.provenance.cached).toBe(true);
  });

  it.each(['item', 'unit', 'quantity', 'supplier name', 'supplier set'])('generates again when %s changes', async (change) => {
    const { generate, fetchMock } = setup();
    await generate();
    const next = structuredClone(request);
    let suppliers = structuredClone(selectedSuppliers);
    if (change === 'item') next.items[0].name = 'Office tables';
    if (change === 'unit') next.items[0].unitLabel = 'sets';
    if (change === 'quantity') next.items[0].quantity += 1;
    if (change === 'supplier name') suppliers[0].name = 'Different company';
    if (change === 'supplier set') { next.selectedSupplierIds.pop(); suppliers = suppliers.slice(0, -1); }
    await generate(next, suppliers);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not allow returned objects to mutate cached offers or provenance', async () => {
    const { generate, fetchMock } = setup();
    const first = await generate();
    first.quotes[0].items[0].price.cents = 1;
    first.assumptions[0] = 'Changed by consumer';
    first.provenance.model = 'Changed by consumer';
    const second = await generate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.quotes[0].items[0].price.cents).toBe(450000);
    expect(second.assumptions[0]).not.toBe('Changed by consumer');
    expect(second.provenance.model).toBe('example/model');
  });

  it('expires one week after generation without extending expiry on hits', async () => {
    const { generate, fetchMock, advance } = setup();
    await generate();
    advance((7 * 24 - 1) * 60 * 60 * 1000);
    await generate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(60 * 60 * 1000);
    await generate();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors the earlier server expiry and does not restart TTL when receiving cached server data', async () => {
    let timestamp = generatedAt;
    const fetcher = vi.fn(async () => {
      const value = { ...payload(), provenance: { ...payload().provenance, cached: true, generatedAt: new Date(timestamp).toISOString(), expiresAt: new Date(timestamp + 60000).toISOString(), cacheVersion: 'procurement-estimates-v4' } };
      return new Response(JSON.stringify(value));
    });
    const client = createEstimateClient({ fetcher, now: () => timestamp });
    await client.generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal);
    timestamp += 60 * 1000;
    await client.generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refetches when a cached entry expires while preparing its response', async () => {
    const now = vi.fn().mockReturnValueOnce(generatedAt).mockReturnValueOnce(generatedAt).mockReturnValueOnce(generatedAt)
      .mockReturnValueOnce(generatedAt + 99).mockReturnValue(generatedAt + 100);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ...payload(), provenance: { ...payload().provenance, generatedAt: new Date(fetcher.mock.calls.length === 1 ? generatedAt : generatedAt + 100).toISOString() },
    })));
    const client = createEstimateClient({ fetcher, now, ttlMs: 100 });
    await client.generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal);
    const refreshed = await client.generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refreshed.provenance.cached).toBe(false);
    expect(refreshed.provenance.generatedAt).toBe(new Date(generatedAt + 100).toISOString());
  });

  it('rejects already expired responses without caching or automatically retrying', async () => {
    const provenance = { ...payload().provenance, generatedAt: '2026-09-26T11:49:00Z' };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...payload(), provenance })));
    const client = createEstimateClient({ fetcher, now: () => generatedAt });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(client.generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' });
      expect(fetcher).toHaveBeenCalledTimes(attempt + 1);
    }
  });

  it('never caches responses for another prompt version', async () => {
    const provenance = { ...payload().provenance, cacheVersion: 'outdated-prompt' };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...payload(), provenance })));
    const client = createEstimateClient({ fetcher, now: () => generatedAt });
    await client.generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal);
    await client.generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reuses valid offers on the next UTC day while within the one-week TTL', async () => {
    const { generate, fetchMock, setTime, advance } = setup();
    setTime(Date.parse('2026-10-03T23:59:00Z'));
    await generate();
    advance(2 * 60 * 1000);
    await generate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains a previous-day Redis result with its original generated-at and as-of dates', async () => {
    const provenance = { ...payload().provenance, cached: true, asOfDate: '2026-10-03', expiresAt: '2026-10-10T12:00:00Z', cacheVersion: 'procurement-estimates-v4' };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...payload(), provenance })));
    const client = createEstimateClient({ fetcher, now: () => generatedAt + 24 * 60 * 60 * 1000 });
    await client.generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal);
    const cached = await client.generateEstimates(request, selectedSuppliers, 'earliest_delivery', new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cached.provenance).toMatchObject({ cached: true, generatedAt: '2026-10-03T12:00:00Z', asOfDate: '2026-10-03' });
  });

  it('refetches the whole configuration once any cached delivery date is in the past', async () => {
    let timestamp = generatedAt;
    const fetcher = vi.fn(async () => {
      const value = payload();
      value.provenance.generatedAt = new Date(timestamp).toISOString();
      value.quotes[0].items[0].expectedDate = fetcher.mock.calls.length === 1 ? '2026-10-03' : '2026-10-12';
      return new Response(JSON.stringify(value));
    });
    const client = createEstimateClient({ fetcher, now: () => timestamp });
    const generate = () => client.generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal);
    await generate();
    await generate();
    expect(fetcher).toHaveBeenCalledTimes(1);
    timestamp += 24 * 60 * 60 * 1000;
    const refreshed = await generate();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refreshed.quotes[0].items[0].expectedDate).toBe('2026-10-12');
    await generate();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects a newly received response with past delivery dates without caching it', async () => {
    const value = payload();
    value.quotes[0].items[0].expectedDate = '2026-10-02';
    const fetcher = vi.fn(async () => new Response(JSON.stringify(value)));
    const client = createEstimateClient({ fetcher, now: () => generatedAt });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(client.generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' });
      expect(fetcher).toHaveBeenCalledTimes(attempt + 1);
    }
  });

  it('evicts least recently used entries when the cache is full', async () => {
    const { generate, fetchMock } = setup({ maxEntries: 2 });
    const another = { ...request, items: [{ ...request.items[0], name: 'Tables' }] };
    const third = { ...request, items: [{ ...request.items[0], name: 'Stools' }] };
    await generate();
    await generate(another);
    await generate();
    await generate(third);
    await generate();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await generate(another);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('keeps cache isolated to each client/page instance', async () => {
    const first = setup();
    const second = setup();
    await first.generate();
    await second.generate();
    expect(first.fetchMock).toHaveBeenCalledTimes(1);
    expect(second.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['service error', 'invalid output'])('does not cache %s', async (failure) => {
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 1) {
        if (failure === 'service error') return new Response(JSON.stringify({ error: 'Try again', code: 'request_failed' }), { status: 503 });
        const invalid = payload();
        invalid.quotes.pop();
        return new Response(JSON.stringify(invalid));
      }
      return new Response(JSON.stringify(payload()));
    });
    const client = createEstimateClient({ fetcher, now: () => generatedAt });
    await expect(client.generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal)).rejects.toBeDefined();
    await client.generateEstimates(request, selectedSuppliers, 'lowest_cost', new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('shared pending estimate requests', () => {
  function setup() {
    let finish!: (response: Response) => void;
    const networkSignals: AbortSignal[] = [];
    const fetcher = vi.fn((_url: RequestInfo | URL, options?: RequestInit) => new Promise<Response>((resolve, reject) => {
      finish = resolve;
      const signal = options?.signal as AbortSignal;
      networkSignals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const client = createEstimateClient({ fetcher, now: () => generatedAt });
    const generate = (signal = new AbortController().signal, preference: 'lowest_cost' | 'earliest_delivery' = 'lowest_cost') =>
      client.generateEstimates(request, selectedSuppliers, preference, signal);
    return { generate, fetcher, networkSignals, finish: () => finish(new Response(JSON.stringify(payload()))) };
  }

  it('deduplicates simultaneous submissions including different preferences', async () => {
    const { generate, fetcher, finish } = setup();
    const first = generate();
    const second = generate(new AbortController().signal, 'earliest_delivery');
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish();
    const results = await Promise.all([first, second]);
    expect(results[0].comparisons.lowest_cost.recommendedSupplierIds).toEqual(['metro']);
    expect(results[1].comparisons.earliest_delivery.recommendedSupplierIds).toEqual(['comfort']);
    await generate();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels one caller without cancelling another caller sharing its network request', async () => {
    const { generate, fetcher, networkSignals, finish } = setup();
    const controller = new AbortController();
    const first = generate(controller.signal);
    const second = generate();
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(networkSignals[0].aborted).toBe(false);
    finish();
    await expect(second).resolves.toMatchObject({ provenance: { kind: 'ai_estimate' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('aborts the network only after all callers cancel and permits a fresh retry', async () => {
    const { generate, fetcher, networkSignals, finish } = setup();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = generate(firstController.signal);
    const second = generate(secondController.signal);
    const firstAssertion = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const secondAssertion = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    firstController.abort();
    expect(networkSignals[0].aborted).toBe(false);
    secondController.abort();
    expect(networkSignals[0].aborted).toBe(true);
    const retry = generate();
    expect(fetcher).toHaveBeenCalledTimes(2);
    finish();
    await Promise.all([firstAssertion, secondAssertion, retry]);
    await generate();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('never sends a request for an already cancelled caller', async () => {
    const { generate, fetcher } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(generate(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
