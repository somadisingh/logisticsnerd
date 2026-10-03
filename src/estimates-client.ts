import { compareQuotes } from './domain/compare';
import type { ComparisonResult, ProcurementRequest, PurchasingPreference, SupplierQuote } from './domain/model';

export interface EstimateProvenance {
  kind: 'ai_estimate';
  model: string;
  generatedAt: string;
  cached: boolean;
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

export async function generateEstimates(
  request: ProcurementRequest,
  suppliers: Array<{ id: string; name: string }>,
  preference: PurchasingPreference,
  signal: AbortSignal,
): Promise<EstimateResponse> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 65000);
  try {
    const response = await fetch('/api/procurement/estimates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request, suppliers, preference }), signal: controller.signal,
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
    if (signal.aborted || error instanceof EstimateError) throw error;
    throw new EstimateError('We could not reach the estimate service. Please try again.', 'connection_failed');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
