import { compareQuotes } from './domain/compare';
import type { ComparisonResult, ProcurementRequest, PurchasingPreference, SupplierQuote } from './domain/model';
import { isCalendarDate, validateComparisonInput } from './domain/validate';

export interface EstimateProvenance {
  kind: 'ai_estimate';
  model: string;
  generatedAt: string;
  cached: boolean;
  expiresAt?: string;
  cacheVersion?: string;
  asOfDate?: string;
}

export interface EstimateResponse {
  quotes: SupplierQuote[];
  comparisons: { lowest_cost: ComparisonResult; earliest_delivery: ComparisonResult };
  provenance: EstimateProvenance;
  assumptions: string[];
}

export class EstimateError extends Error {
  constructor(message: string, public code = 'request_failed') { super(message); this.name = 'EstimateError'; }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit = 1000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}

/** Keep provider output outside the UI until it passes the application's own rules. */
export function validateEstimateResponse(value: unknown, request: ProcurementRequest): EstimateResponse {
  try {
    if (!object(value) || !Array.isArray(value.quotes) || value.quotes.length !== request.selectedSupplierIds.length) throw new Error();
    for (const quote of value.quotes) {
      if (!object(quote) || !text(quote.id, 160) || !text(quote.requestId, 160) || !text(quote.supplierId, 160)
        || !text(quote.submittedAt, 80) || !Number.isFinite(Date.parse(quote.submittedAt))
        || (quote.notes !== undefined && !text(quote.notes, 1000)) || !Array.isArray(quote.items) || quote.items.length !== 1) throw new Error();
      const item = quote.items[0];
      if (!object(item) || !text(item.requestedItemId, 160) || !text(item.expectedDate, 10) || !object(item.price)) throw new Error();
    }
    const provenance = value.provenance;
    if (!object(provenance) || provenance.kind !== 'ai_estimate' || !text(provenance.model, 160)
      || !text(provenance.generatedAt, 80) || !Number.isFinite(Date.parse(provenance.generatedAt)) || typeof provenance.cached !== 'boolean') throw new Error();
    if (provenance.expiresAt !== undefined && (!text(provenance.expiresAt, 80) || !Number.isFinite(Date.parse(provenance.expiresAt)))) throw new Error();
    if (provenance.cacheVersion !== undefined && !text(provenance.cacheVersion, 160)) throw new Error();
    if (provenance.asOfDate !== undefined && (typeof provenance.asOfDate !== 'string' || !isCalendarDate(provenance.asOfDate))) throw new Error();
    if (!Array.isArray(value.assumptions) || value.assumptions.length > 12 || value.assumptions.some((assumption) => !text(assumption))) throw new Error();
    const quotes = value.quotes as SupplierQuote[];
    // Recompute both decisions rather than trusting recommendations in the response.
    const comparisons = {
      lowest_cost: compareQuotes(request, quotes, 'lowest_cost'),
      earliest_delivery: compareQuotes(request, quotes, 'earliest_delivery'),
    };
    return { quotes, comparisons, provenance: provenance as unknown as EstimateProvenance, assumptions: value.assumptions as string[] };
  } catch {
    throw new EstimateError('The estimates did not pass our checks. Please try again.', 'invalid_response');
  }
}

export async function estimateStatus(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/api/procurement/status', { signal: controller.signal, cache: 'no-store' });
    const value: unknown = await response.json();
    if (!response.ok || !object(value) || typeof value.configured !== 'boolean') throw new Error('Unavailable');
    return value.configured;
  } finally { clearTimeout(timer); }
}

type EstimateSuppliers = Array<{ id: string; name: string }>;
type EstimateGenerator = (
  request: ProcurementRequest,
  suppliers: EstimateSuppliers,
  preference: PurchasingPreference,
  signal: AbortSignal,
) => Promise<EstimateResponse>;

const CACHE_VERSION = 'procurement-estimates-v4';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedOffer {
  supplierId: string;
  submittedAt: string;
  notes?: string;
  item: Omit<SupplierQuote['items'][number], 'requestedItemId'>;
}

interface CachedEstimates {
  offers: CachedOffer[];
  provenance: EstimateProvenance;
  assumptions: string[];
  expiresAt: number;
}

interface PendingEstimates {
  controller: AbortController;
  promise: Promise<CachedEstimates>;
  subscribers: number;
}

function normalize(value: string): string { return value.trim().replace(/\s+/g, ' ').toLowerCase(); }

function cacheKey(request: ProcurementRequest, suppliers: EstimateSuppliers): string {
  validateComparisonInput(request, []);
  const selected = new Set(request.selectedSupplierIds);
  if (suppliers.length !== selected.size || new Set(suppliers.map((supplier) => supplier.id)).size !== selected.size
    || suppliers.some((supplier) => !selected.has(supplier.id) || !supplier.name.trim())) {
    throw new EstimateError('Select valid suppliers before generating estimates.', 'invalid_request');
  }
  const item = request.items[0];
  // Budget, deadline, preference and request IDs affect comparisons, not the generated offers.
  return JSON.stringify([
    CACHE_VERSION, normalize(item.name), normalize(item.unitLabel ?? 'units'), item.quantity,
    suppliers.map((supplier) => [supplier.id, normalize(supplier.name)]).sort((a, b) => a[0].localeCompare(b[0])),
  ]);
}

function isFresh(estimates: CachedEstimates, timestamp: number): boolean {
  const currentDate = new Date(timestamp).toISOString().slice(0, 10);
  return estimates.expiresAt > timestamp && estimates.offers.every((offer) => offer.item.expectedDate >= currentDate);
}

function snapshotEstimates(response: EstimateResponse, receivedAt: number, ttlMs: number): CachedEstimates {
  const generatedAt = Date.parse(response.provenance.generatedAt);
  return {
    offers: response.quotes.map((quote) => ({
      supplierId: quote.supplierId, submittedAt: quote.submittedAt, ...(quote.notes === undefined ? {} : { notes: quote.notes }),
      item: { availableQuantity: quote.items[0].availableQuantity, expectedDate: quote.items[0].expectedDate, price: { ...quote.items[0].price } },
    })),
    provenance: structuredClone(response.provenance), assumptions: [...response.assumptions],
    // A server cache hit must retain its original expiry; browser hits never extend it.
    expiresAt: Math.min(generatedAt + ttlMs, receivedAt + ttlMs, response.provenance.expiresAt ? Date.parse(response.provenance.expiresAt) : Infinity),
  };
}

function responseForRequest(estimates: CachedEstimates, request: ProcurementRequest, cached: boolean): EstimateResponse {
  const quotes: SupplierQuote[] = estimates.offers.map((offer, index) => ({
    id: `estimate-${request.id.slice(0, 140)}-${index + 1}`, requestId: request.id, supplierId: offer.supplierId, submittedAt: offer.submittedAt,
    ...(offer.notes === undefined ? {} : { notes: offer.notes }),
    items: [{ ...offer.item, price: { ...offer.item.price }, requestedItemId: request.items[0].id }],
  }));
  return validateEstimateResponse({
    quotes, provenance: { ...structuredClone(estimates.provenance), cached: cached || estimates.provenance.cached }, assumptions: [...estimates.assumptions],
  }, request);
}

async function fetchEstimates(
  fetcher: typeof fetch,
  request: ProcurementRequest,
  suppliers: EstimateSuppliers,
  preference: PurchasingPreference,
  controller: AbortController,
): Promise<EstimateResponse> {
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 65000);
  try {
    const response = await fetcher('/api/procurement/estimates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request, suppliers, preference }), signal: controller.signal, cache: 'no-store',
    });
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new EstimateError('The estimate service returned an unreadable response. Please try again.', 'invalid_response'); }
    if (!response.ok) {
      const message = object(value) && text(value.clarification) ? value.clarification
        : object(value) && text(value.error) ? value.error : 'We could not generate estimates. Please try again.';
      throw new EstimateError(message, object(value) && text(value.code, 80) ? value.code : 'request_failed');
    }
    return validateEstimateResponse(value, request);
  } catch (error) {
    if (timedOut) throw new EstimateError('The estimates took too long. Please try again.', 'request_timeout');
    if (controller.signal.aborted || error instanceof EstimateError) throw error;
    throw new EstimateError('We could not reach the estimate service. Please try again.', 'connection_failed');
  } finally {
    clearTimeout(timer);
  }
}

/** A page-memory cache: no estimates or buyer inputs are persisted in browser storage. */
export function createEstimateClient(options: {
  fetcher?: typeof fetch;
  now?: () => number;
  maxEntries?: number;
  ttlMs?: number;
} = {}): { generateEstimates: EstimateGenerator } {
  const fetcher: typeof fetch = options.fetcher ?? ((...args) => fetch(...args));
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 20;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > CACHE_TTL_MS) {
    throw new Error('Invalid estimate cache settings.');
  }
  const completed = new Map<string, CachedEstimates>();
  const pending = new Map<string, PendingEstimates>();

  function subscribe(entry: PendingEstimates, request: ProcurementRequest, signal: AbortSignal, joined: boolean): Promise<EstimateResponse> {
    entry.subscribers += 1;
    return new Promise((resolve, reject) => {
      let active = true;
      const release = () => {
        active = false;
        signal.removeEventListener('abort', cancel);
        entry.subscribers -= 1;
      };
      const cancel = () => {
        if (!active) return;
        release();
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        if (entry.subscribers === 0) entry.controller.abort(signal.reason);
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      entry.promise.then((estimates) => {
        if (!active) return;
        release();
        try {
          const response = responseForRequest(estimates, request, joined);
          if (!isFresh(estimates, now())) throw new EstimateError('The estimates expired or their delivery dates have passed. Please generate fresh estimates.', 'invalid_response');
          resolve(response);
        }
        catch (error) { reject(error); }
      }, (error) => {
        if (!active) return;
        release();
        reject(error);
      });
    });
  }

  const generate: EstimateGenerator = async (request, suppliers, preference, signal) => {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const capturedRequest = structuredClone(request);
    const capturedSuppliers = structuredClone(suppliers);
    const requestedAt = now();
    const key = cacheKey(capturedRequest, capturedSuppliers);
    for (const [entryKey, entry] of completed) if (!isFresh(entry, requestedAt)) completed.delete(entryKey);
    const existing = completed.get(key);
    if (existing) {
      const response = responseForRequest(existing, capturedRequest, true);
      completed.delete(key);
      if (isFresh(existing, now())) {
        completed.set(key, existing);
        return response;
      }
    }
    const active = pending.get(key);
    if (active && !active.controller.signal.aborted) return subscribe(active, capturedRequest, signal, true);

    const controller = new AbortController();
    const entry: PendingEstimates = { controller, subscribers: 0, promise: undefined as unknown as Promise<CachedEstimates> };
    entry.promise = fetchEstimates(fetcher, capturedRequest, capturedSuppliers, preference, controller).then((response) => {
      const receivedAt = now();
      const estimates = snapshotEstimates(response, receivedAt, ttlMs);
      if (!isFresh(estimates, receivedAt)) throw new EstimateError('The estimates expired or their delivery dates have passed. Please generate fresh estimates.', 'invalid_response');
      if (!controller.signal.aborted && (response.provenance.cacheVersion === undefined || response.provenance.cacheVersion === CACHE_VERSION)) {
        completed.delete(key);
        completed.set(key, estimates);
        while (completed.size > maxEntries) completed.delete(completed.keys().next().value!);
      }
      return estimates;
    }).finally(() => { if (pending.get(key) === entry) pending.delete(key); });
    // Cancellation can detach all subscribers before fetch settles. Always handle its rejection.
    void entry.promise.catch(() => {});
    pending.set(key, entry);
    return subscribe(entry, capturedRequest, signal, false);
  };
  return { generateEstimates: generate };
}

const defaultClient = createEstimateClient();
export const generateEstimates = defaultClient.generateEstimates;
