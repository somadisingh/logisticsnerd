export type WorkflowAction = 'create_order' | 'reserve' | 'compare' | 'approve'
  | 'receive_x' | 'receive_y' | 'fulfill' | 'replay' | 'check_isolation' | 'reset';

interface Quote {
  id: string;
  business_id: string;
  line_id: string;
  supplier_id: string;
  capacity_quantity: number;
  quantity_priced: number;
  price_cents: number;
  pricing_kind: 'unit' | 'total';
  currency: string;
  source: 'synthetic' | 'ai_estimate' | 'supplier';
  generated_at: string;
  expires_at: string;
  expected_date: string;
  estimated?: boolean;
}

export interface Snapshot {
  mode: 'in_memory';
  supplier_data: 'synthetic';
  company: { id: string; name: string; currency: string; owner_id: string };
  scenario: { quantity: number };
  suppliers: Array<{
    id: string;
    name: string;
    capacity_quantity: number;
    quantity_priced: number;
    unit_price_cents: number;
    expected_date: string;
  }>;
  clock: string;
  deadline: string;
  budget_cents: number;
  item: { id: string; name: string; sku: string };
  stock: { on_hand: number; reserved: number; available: number };
  other_order: { id: string; reserved_quantity: number };
  order: {
    id: string;
    business_id: string;
    customer_id: string;
    line_ids: string[];
    status: 'open' | 'ready' | 'fulfilled';
    created_at: string;
    fulfilled_at: string | null;
  } | null;
  lines: Array<{
    id: string;
    business_id: string;
    order_id: string;
    item_id: string;
    quantity: number;
    required_by: string;
    maximum_budget_cents: number | null;
    priority: string;
    reserved_quantity: number;
    original_shortage: number | null;
    shortage: {
      demand: number;
      reserved: number;
      original_shortage: number | null;
      physical_shortage: number;
      approved_inbound: number;
      quantity_to_purchase: number;
    };
  }>;
  quotes: Quote[];
  recommendation: {
    feasible: boolean;
    allocations: Array<{ quote_id: string; quantity: number; total_cents: number }>;
    total_cents: number;
    explanations: string[];
  } | null;
  purchases: Array<{
    id: string;
    business_id: string;
    line_id: string;
    quote_id: string;
    supplier_id: string;
    quantity: number;
    total_cents: number;
    currency: string;
    approver_id: string;
    approved_at: string;
    quote_snapshot: Quote;
    status: 'approved' | 'received';
    received_at: string | null;
  }>;
  events: Array<{ sequence: number; action: string; label: string; detail: string; ok: boolean }>;
}

export interface WorkflowResponse {
  ok: boolean;
  error?: string;
  snapshot: Snapshot;
}

export class WorkflowError extends Error {
  constructor(message: string, public code: 'connection_failed' | 'request_timeout' | 'invalid_response' | 'http_error') {
    super(message);
    this.name = 'WorkflowError';
  }
}

const ENDPOINT = '/api/demo/workflow';
const TIMEOUT_MS = 10000;
const START_HELP = 'Start the local app with npm run dev, then retry.';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function quantity(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function message(value: unknown): string | undefined {
  if (!nonempty(value)) return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > 240 ? `${clean.slice(0, 237)}…` : clean;
}

function validSnapshot(value: unknown): value is Snapshot {
  if (!object(value) || value.mode !== 'in_memory' || value.supplier_data !== 'synthetic') return false;
  const { company, item, stock } = value;
  if (!object(company) || !['id', 'name', 'currency', 'owner_id'].every((key) => nonempty(company[key]))) return false;
  if (!object(value.scenario) || !quantity(value.scenario.quantity) || value.scenario.quantity === 0) return false;
  if (!Array.isArray(value.suppliers) || !value.suppliers.every((supplier: unknown) => object(supplier)
    && nonempty(supplier.id) && nonempty(supplier.name) && quantity(supplier.capacity_quantity)
    && quantity(supplier.quantity_priced) && supplier.quantity_priced > 0
    && quantity(supplier.unit_price_cents) && nonempty(supplier.expected_date))) return false;
  if (!object(item) || !['id', 'name', 'sku'].every((key) => nonempty(item[key]))) return false;
  if (!object(stock) || !['on_hand', 'reserved', 'available'].every((key) => quantity(stock[key]))) return false;
  if (!object(value.other_order) || !nonempty(value.other_order.id) || !quantity(value.other_order.reserved_quantity)) return false;
  if (!nonempty(value.clock) || !nonempty(value.deadline) || !quantity(value.budget_cents)) return false;
  if (value.order !== null && (!object(value.order) || !['open', 'ready', 'fulfilled'].includes(String(value.order.status)))) return false;
  if (value.recommendation !== null && (!object(value.recommendation) || typeof value.recommendation.feasible !== 'boolean'
    || !Array.isArray(value.recommendation.allocations) || !Array.isArray(value.recommendation.explanations))) return false;
  return ['lines', 'quotes', 'purchases', 'events'].every((key) => Array.isArray(value[key]) && value[key].every(object));
}

async function request(init: RequestInit): Promise<WorkflowResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      ...init, cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
    });
    let value: unknown;
    try { value = await response.json(); }
    catch {
      if (!response.ok) throw new WorkflowError(`The workflow demo returned HTTP ${response.status}. ${START_HELP}`, 'http_error');
      throw new WorkflowError(`The workflow demo returned an unreadable response. ${START_HELP}`, 'invalid_response');
    }
    if (timedOut) throw new WorkflowError(`The workflow demo took too long to respond. ${START_HELP}`, 'request_timeout');
    if (!response.ok) {
      throw new WorkflowError(object(value) && message(value.error)
        || `The workflow demo returned HTTP ${response.status}. ${START_HELP}`, 'http_error');
    }
    if (!object(value) || typeof value.ok !== 'boolean' || !validSnapshot(value.snapshot)) {
      throw new WorkflowError(`The workflow demo returned an unexpected response. ${START_HELP}`, 'invalid_response');
    }
    return {
      ok: value.ok, snapshot: value.snapshot,
      ...(!value.ok ? { error: message(value.error) ?? 'The requested action was rejected.' } : {}),
    };
  } catch (error) {
    if (timedOut) throw new WorkflowError(`The workflow demo took too long to respond. ${START_HELP}`, 'request_timeout');
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError(`The workflow demo is unavailable. ${START_HELP}`, 'connection_failed');
  } finally {
    clearTimeout(timer);
  }
}

export async function getSnapshot(): Promise<Snapshot> {
  const response = await request({ method: 'GET', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new WorkflowError(response.error ?? 'The workflow demo could not be loaded.', 'http_error');
  return response.snapshot;
}

export async function sendAction(action: WorkflowAction, key?: string): Promise<WorkflowResponse> {
  return request({
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...(key === undefined ? {} : { key }) }),
  });
}
