import '@fontsource-variable/dm-sans';
import './styles.css';
import './shipments.css';
import { demoNavigation } from './demo-navigation';

type Values = Record<string, unknown>;
interface Reference { id: number; kind: string; snapshot: Values; external_key: string; valid_to: string | null; local_archived?: boolean; }
interface Demand { demand_line_id: number | null; item_id: number; quantity: number; reserved: number; shipped: number; delivered: number | null; status: string; }
interface Order { order_ref: string; order_number: string; customer_name?: string | null; ship_to_address?: string | null; lines: Demand[]; }
interface Reservation { reservation_id: number; item_id: number; location_id: number; order_ref: string; demand_line_id: number | null; status: string; quantity: number; quantity_shipped: number; remaining_quantity: number; planned_quantity: number; available_to_plan: number; }
interface ShipmentSummary { shipment_id: number; shipment_number: string; order_ref: string | null; status: string; carrier: string | null; label_ref: string | null; tracking_ref: string | null; dispatched_on: string | null; line_count: number; total_quantity: number; }
interface Movement { movement_id: number; lot_id: number | null; lot_number: string | null; quantity: number; }
interface ShipmentLine { line_id: number; shipment_line_id: number; reservation_id: number; order_ref: string; item_id: number; location_id: number; demand_line_id: number | null; quantity: number; movements: Movement[]; }
interface TrackingEvent { event_id: number; event: string; occurred_at: string; detail: string | null; }
interface Shipment extends ShipmentSummary { lines: ShipmentLine[]; events: TrackingEvent[]; }
interface Stock { item_id: number; location_id: number; on_hand: number; reserved: number; available: number; }
interface Workspace { orders: Order[]; reservations: Reservation[]; shipments: ShipmentSummary[]; stock: Stock[]; references: Reference[]; }

const app = document.querySelector<HTMLDivElement>('#app')!;
const endpoint = '/api/fulfillment';
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const text = (fields: FormData, name: string) => String(fields.get(name) ?? '').trim();
const number = (fields: FormData, name: string) => {
  const value = Number(text(fields, name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Choose a record and enter a positive whole quantity.');
  return value;
};
const localDate = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };
const localTimestamp = () => { const now = new Date(); return `${localDate()}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`; };
const timestampLabel = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); };
const stateLabel = (value: string) => ({ draft: 'Draft', dispatched: 'Dispatched', in_transit: 'In transit', delivered: 'Delivered', exception: 'Exception', out_for_delivery: 'Out for delivery', delivery_failed: 'Failed delivery', allocated: 'Allocated', received: 'Received', shipped: 'Shipped', released: 'Released' }[value] ?? value);
const pill = (status: string) => `<span class="shipping-pill ${['delivered', 'exception'].includes(status) ? status : ''}">${escape(stateLabel(status))}</span>`;
const input = (name: string, label: string, value: unknown = '', type = 'text', attributes = '') => `<label>${escape(label)}<input name="${escape(name)}" type="${type}" value="${escape(value)}" ${attributes}></label>`;
const button = (label: string, attributes = '', style = '') => `<button class="shipping-button ${style}" ${attributes}>${escape(label)}</button>`;
const empty = (title: string, help: string) => `<div class="shipping-empty"><strong>${escape(title)}</strong><p>${escape(help)}</p></div>`;
const table = (headers: string[], rows: unknown[][]) => rows.length ? `<div class="shipping-table-wrap"><table class="shipping-table"><thead><tr>${headers.map(header => `<th scope="col">${escape(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
let loading = true;
let data: Workspace | undefined;
let selectedOrder = '';
let selectedShipment: number | undefined;
let detail: Shipment | undefined;
let busy = false;
let message = '';
let failed = false;
// Retain the logical request key until both its command and refreshed view succeed.
const pending = new Map<string, string>();
const completedRequests = new Set<string>();
const order = () => data?.orders.find(value => value.order_ref === selectedOrder);
const orderLabel = (reference: string | null) => data?.orders.find(value => value.order_ref === reference)?.order_number ?? reference ?? 'Order not specified';
const referenceName = (id: number) => { const ref = data?.references.find(value => value.id === id); return String(ref?.snapshot.name ?? ref?.snapshot.label ?? ref?.external_key ?? `#${id}`); };
const orderShipments = () => data?.shipments.filter(value => value.order_ref === selectedOrder) ?? [];
const plannableReservations = () => data?.reservations.filter(value => value.order_ref === selectedOrder && value.status === 'active' && value.available_to_plan > 0 && !detail?.lines.some(line => line.reservation_id === value.reservation_id)) ?? [];

async function request<T>(path: string, body?: Values): Promise<T> {
  const identity = `${path}:${JSON.stringify(body)}`;
  const key = body ? pending.get(identity) ?? crypto.randomUUID() : undefined;
  if (key) pending.set(identity, key);
  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify({ ...body, idempotency_key: key }) } : {}) });
  } catch { throw new Error('Could not reach the shipping server. Your input is unchanged. Retry the same request when the connection returns.'); }
  let value: T & { error?: { message?: string; fields?: { location: unknown[]; message: string }[] }; detail?: string };
  try { value = await response.json(); } catch { throw new Error(`The server could not complete this request (${response.status}). Retry the same request.`); }
  if (!response.ok) {
    const issues = value.error?.fields?.map(issue => `${issue.location.slice(1).join('.')}: ${issue.message}`).join('; ');
    throw new Error(issues || value.error?.message || value.detail || 'The request could not be completed.');
  }
  if (body) completedRequests.add(identity);
  return value;
}

async function refresh() {
  const next = await request<Workspace>('/workspace');
  const nextOrder = next.orders.some(value => value.order_ref === selectedOrder) ? selectedOrder : next.orders[0]?.order_ref ?? '';
  const shipments = next.shipments.filter(value => value.order_ref === nextOrder);
  const nextShipment = shipments.find(value => value.shipment_id === selectedShipment)?.shipment_id ?? shipments[0]?.shipment_id;
  const nextDetail = nextShipment ? await request<Shipment>(`/shipments/${nextShipment}`) : undefined;
  data = next; selectedOrder = nextOrder; selectedShipment = nextShipment; detail = nextDetail;
}

function feedback(value: string, error = false) {
  message = value; failed = error;
  const element = document.querySelector<HTMLElement>('.shipping-feedback');
  if (element) { element.textContent = message; element.classList.toggle('error', failed); }
}

async function run(work: () => Promise<unknown>, success: string) {
  if (busy) return false;
  busy = true;
  feedback('Working…');
  const controls = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input,select,button,textarea')];
  const disabled = controls.map(control => control.disabled);
  controls.forEach(control => control.disabled = true);
  let commandFinished = false;
  try {
    await work();
    commandFinished = true;
    await refresh();
    completedRequests.forEach(identity => pending.delete(identity)); completedRequests.clear();
    message = success; failed = false; busy = false; render();
    return true;
  } catch (error) {
    feedback(commandFinished && completedRequests.size > 0
      ? 'The action was saved, but the latest view could not be loaded. Retry with the same inputs, or select Refresh. The request key is retained to prevent duplicates.'
      : error instanceof Error ? error.message : 'The request could not be completed.', true);
    document.querySelector('.shipping-feedback')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return false;
  } finally {
    busy = false;
    controls.forEach((control, index) => { if (control.isConnected) control.disabled = disabled[index]; });
  }
}

function bindForm(id: string, work: (fields: FormData) => Promise<unknown>, success: string) {
  const form = document.querySelector<HTMLFormElement>(`#${id}`);
  form?.addEventListener('submit', event => { event.preventDefault(); const fields = new FormData(form); void run(() => work(fields), success); });
}

function customerPanel() {
  const current = order();
  const reservations = data!.reservations.filter(value => value.order_ref === selectedOrder);
  return `<section class="shipping-panel shipping-wide"><div class="shipping-panel-heading"><div><h2>1. Choose a customer order</h2><p>Ship stock already reserved for this order. Goods received for an order become available here.</p></div><a class="shipping-button quiet small" href="/purchasing.html">Receive goods →</a></div>
    ${data!.orders.length ? `<label class="shipping-order-select">Customer order<select id="order-select">${data!.orders.map(value => `<option value="${escape(value.order_ref)}" ${value.order_ref === selectedOrder ? 'selected' : ''}>${escape(value.order_number)}${value.customer_name ? ` · ${escape(value.customer_name)}` : ''}</option>`).join('')}</select></label>
    <div class="shipping-order-meta">${current?.customer_name ? `<strong>${escape(current.customer_name)}</strong>` : ''}${current?.ship_to_address ? `<span>Ship to: ${escape(current.ship_to_address)}</span>` : ''}</div>
    ${current?.lines.length ? table(['Item', 'Ordered', 'Reserved', 'Shipped', 'Delivered', 'Fulfillment'], current.lines.map(line => [referenceName(line.item_id), line.quantity, line.reserved, line.shipped, line.delivered, stateLabel(line.status)])) : ''}
    <h3>Reserved stock for this order</h3>${reservations.length ? table(['Item', 'Location', 'Reservation', 'Remaining', 'On draft shipments', 'Available to plan'], reservations.map(value => [referenceName(value.item_id), referenceName(value.location_id), `#${value.reservation_id}`, value.remaining_quantity, value.planned_quantity, value.available_to_plan])) : empty('No reserved stock yet.', 'Receive goods with a reservation for this customer order before adding shipment lines.')}` : empty('No customer orders to ship yet.', 'Create and submit an order in Business setup & records, then receive and reserve its goods.')} </section>`;
}

function draftPanel() {
  const shipments = orderShipments();
  const available = data!.reservations.some(value => value.order_ref === selectedOrder && value.status === 'active' && value.available_to_plan > 0);
  return `<section class="shipping-panel"><h2>2. Prepare a shipment</h2><p>A shipment contains items for one customer order. Separate shipments can fulfill the order in portions.</p><form id="create-shipment-form"><div class="shipping-fields">${input('shipment_number','Shipment number','','text','required maxlength="200" placeholder="For example: SHIP-001"')}</div>${button('Create draft', !selectedOrder || !available ? 'disabled' : '')}</form>${!available && selectedOrder ? '<p>Receive and reserve goods, or select an order with stock available to plan.</p>' : ''}
    <h3>Shipments for this order</h3>${shipments.length ? `<label>Shipment<select id="shipment-select">${shipments.map(value => `<option value="${value.shipment_id}" ${value.shipment_id === selectedShipment ? 'selected' : ''}>${escape(value.shipment_number)} · ${escape(stateLabel(value.status))} · ${value.total_quantity} units</option>`).join('')}</select></label>` : '<p>No shipments created for this order yet.</p>'}</section>`;
}

function linePanel() {
  if (!detail || detail.status !== 'draft') return '';
  const reservations = plannableReservations();
  return `<section class="shipping-panel"><h2>Add reserved items</h2><p>Select a reservation and the quantity to send in this shipment. Partial quantities leave the rest for another shipment.</p>${reservations.length ? `<form id="shipment-line-form"><div class="shipping-fields"><label class="shipping-span">Reserved stock<select name="reservation_id" required><option value="">Select…</option>${reservations.map(value => `<option value="${value.reservation_id}">${escape(referenceName(value.item_id))} · ${escape(referenceName(value.location_id))} · ${value.available_to_plan} available</option>`).join('')}</select></label>${input('quantity','Quantity',1,'number','required min="1" step="1"')}<p id="reservation-limit">Choose a reservation to see its available quantity.</p></div>${button('Add shipment line')}</form>` : empty('No additional stock available to plan.', 'Reservations already on this shipment cannot be added again. Receive more goods or review the lines below.')}<p>Check the quantity before adding it. Saved shipment lines cannot be edited or removed in this version.</p></section>`;
}

function detailPanel() {
  if (!detail) return `<section class="shipping-panel shipping-wide">${empty('Create or select a shipment.', 'Its lines, dispatch details and delivery history will appear here.')}</section>`;
  const quantity = detail.lines.reduce((total, line) => total + line.quantity, 0);
  const carriers = data!.references.filter(ref => ref.kind === 'carrier' && !ref.valid_to && !ref.local_archived);
  return `<section class="shipping-panel shipping-wide" id="shipment-detail"><div class="shipping-panel-heading"><div><h2>${escape(detail.shipment_number)}</h2><p>${escape(orderLabel(detail.order_ref))} · ${quantity} ${quantity === 1 ? 'unit' : 'units'} across ${detail.lines.length} ${detail.lines.length === 1 ? 'line' : 'lines'}</p></div>${pill(detail.status)}</div>
    ${detail.lines.length ? table(['Item', 'Location', 'Reservation', 'Quantity', 'Posted stock movements'], detail.lines.map(line => [referenceName(line.item_id), referenceName(line.location_id), `#${line.reservation_id}`, line.quantity, line.movements.length ? line.movements.map(value => `#${value.movement_id}${value.lot_number ? ` · lot ${value.lot_number}` : ''} · ${value.quantity} units`).join('; ') : 'None yet'])) : empty('This draft has no lines.', 'Add reserved items before dispatching it.')}
    ${detail.status === 'draft' ? `<div class="shipping-impact"><strong>Dispatch effect:</strong> ${quantity ? `${quantity} ${quantity === 1 ? 'unit leaves' : 'units leave'} inventory. On-hand and reserved quantities decrease together.` : 'Adding draft lines does not change inventory.'}</div>
    <h3>3. Dispatch this shipment</h3><p>Enter the carrier and an existing tracking or label reference. References are recorded manually; this page does not purchase or generate carrier labels.</p><form id="dispatch-form"><div class="shipping-fields">${input('carrier','Carrier','','text','required maxlength="200" list="known-carriers"')}${input('as_of','Dispatch date',localDate(),'date','required')}${input('tracking_ref','Tracking reference (or provide a label)','','text','maxlength="200"')}${input('label_ref','Label reference (optional)','','text','maxlength="200"')}</div><datalist id="known-carriers">${carriers.map(ref => `<option value="${escape(referenceName(ref.id))}"></option>`).join('')}</datalist>${button('Dispatch shipment', !detail.lines.length ? 'disabled' : '')}</form>` : `<dl class="shipping-dispatch-meta"><div><dt>Carrier</dt><dd>${escape(detail.carrier)}</dd></div><div><dt>Dispatched on</dt><dd>${escape(detail.dispatched_on)}</dd></div><div><dt>Tracking reference</dt><dd>${escape(detail.tracking_ref ?? '—')}</dd></div><div><dt>Label reference</dt><dd>${escape(detail.label_ref ?? '—')}</dd></div></dl><p>This shipment has been dispatched. Its lines and dispatch details are fixed.</p>`}
    </section>`;
}

function trackingPanel() {
  if (!detail) return '';
  return `<section class="shipping-panel"><h2>Delivery history</h2>${detail.events.length ? `<ol class="shipping-history">${detail.events.map(event => `<li><strong>${escape(stateLabel(event.event))}</strong><time datetime="${escape(event.occurred_at)}">${escape(timestampLabel(event.occurred_at))}</time>${event.detail ? `<p>${escape(event.detail)}</p>` : ''}</li>`).join('')}</ol>` : '<p>No carrier updates recorded yet.</p>'}</section>
    <section class="shipping-panel"><h2>4. Record a carrier update</h2><p>Updates change delivery status and leave inventory unchanged. Delivered is final; later updates remain in the history.</p>${detail.status === 'draft' ? empty('Dispatch before recording an update.', 'Delivery events apply to shipments that have left inventory.') : `<form id="tracking-form"><div class="shipping-fields"><label>Carrier update<select name="event" required><option value="in_transit">In transit</option><option value="out_for_delivery">Out for delivery</option><option value="delivery_failed">Failed delivery</option><option value="exception">Exception</option><option value="delivered">Delivered</option></select></label>${input('occurred_at','Update date and time',localTimestamp(),'datetime-local','required')}<label class="shipping-span">Details (optional)<textarea name="detail" maxlength="4000" placeholder="For example: handed to the customer."></textarea></label></div>${button('Save carrier update')}</form>`}</section>`;
}

function render() {
  app.innerHTML = `<main class="shipping-page">${demoNavigation('shipments')}<header class="shipping-header"><div><div class="eyebrow">CUSTOMER SHIPPING</div><h1>From reserved to delivered.</h1><p>Prepare customer shipments, dispatch reserved goods and follow delivery updates. Inventory changes when the shipment leaves.</p></div>${data ? `<div class="shipping-actions">${button('Refresh','type="button" id="refresh"','quiet')}</div>` : ''}</header><div class="shipping-feedback${failed ? ' error' : ''}" role="status" aria-live="polite">${escape(message)}</div>
    ${!data ? `<section class="shipping-panel"><p>${loading ? 'Loading shipping…' : 'Could not load shipping. Start the backend and try again.'}</p>${!loading ? button('Retry', 'type="button" id="retry-load"') : ''}</section>` : `<p class="shipping-note">Shipping</p><div class="shipping-steps" aria-label="Shipping steps"><span>1. Choose order</span><span>2. Prepare shipment</span><span>3. Dispatch goods</span><span>4. Follow delivery</span></div><div class="shipping-grid">${customerPanel()}${draftPanel()}${linePanel()}${detailPanel()}${trackingPanel()}<section class="shipping-panel shipping-wide" id="stock-levels"><h2>Inventory by location</h2><p>On hand is physical stock. Reserved stock is held for customer orders. Available is on hand minus reserved.</p>${data.stock.length ? table(['Item','Location','On hand','Reserved','Available'], data.stock.map(value => [referenceName(value.item_id),referenceName(value.location_id),value.on_hand,value.reserved,value.available])) : empty('No stock recorded yet.', 'Receive goods in Purchasing to start the inventory ledger.')}</section></div>`}</main>`;
  bind();
}

function bind() {
  document.querySelector('#retry-load')?.addEventListener('click', () => { void loadWorkspace(); });
  document.querySelector('#refresh')?.addEventListener('click', () => { void run(async () => {}, 'Shipping and inventory refreshed.'); });
  document.querySelector<HTMLSelectElement>('#order-select')?.addEventListener('change', async event => {
    const control = event.target as HTMLSelectElement;
    const previousOrder = selectedOrder, previousShipment = selectedShipment;
    selectedOrder = control.value; selectedShipment = undefined;
    if (!await run(async () => {}, 'Customer order selected.')) {
      selectedOrder = previousOrder; selectedShipment = previousShipment; control.value = previousOrder;
    }
  });
  document.querySelector<HTMLSelectElement>('#shipment-select')?.addEventListener('change', async event => {
    const control = event.target as HTMLSelectElement;
    const previous = selectedShipment;
    selectedShipment = Number(control.value);
    if (!await run(async () => {}, 'Shipment selected.')) {
      selectedShipment = previous; control.value = String(previous ?? '');
    }
  });
  bindForm('create-shipment-form', async fields => {
    if (!selectedOrder) throw new Error('Select a customer order first.');
    const created = await request<{ shipment_id: number }>('/shipments', { shipment_number: text(fields, 'shipment_number'), order_ref: selectedOrder });
    selectedShipment = created.shipment_id;
  }, 'Shipment draft created. Inventory is unchanged.');
  bindForm('shipment-line-form', fields => {
    if (!detail || detail.status !== 'draft') throw new Error('Select a draft shipment first.');
    const reservationId = number(fields, 'reservation_id');
    const quantity = number(fields, 'quantity');
    const reservation = plannableReservations().find(value => value.reservation_id === reservationId);
    if (!reservation || quantity > reservation.available_to_plan) throw new Error('The quantity exceeds stock available for this shipment. Refresh to see current reservations.');
    return request(`/shipments/${detail.shipment_id}/lines`, { reservation_id: reservationId, quantity });
  }, 'Shipment line added. Inventory is unchanged.');
  document.querySelector<HTMLSelectElement>('#shipment-line-form [name=reservation_id]')?.addEventListener('change', event => {
    const reservation = plannableReservations().find(value => value.reservation_id === Number((event.target as HTMLSelectElement).value));
    const control = document.querySelector<HTMLInputElement>('#shipment-line-form [name=quantity]')!;
    if (reservation) control.max = String(reservation.available_to_plan); else control.removeAttribute('max');
    document.querySelector('#reservation-limit')!.textContent = reservation ? `${reservation.available_to_plan} units available. ${reservation.planned_quantity} already on draft shipments.` : 'Choose a reservation to see its available quantity.';
  });
  bindForm('dispatch-form', fields => {
    if (!detail || detail.status !== 'draft' || !detail.lines.length) throw new Error('Add reserved items to a draft shipment before dispatch.');
    const tracking = text(fields, 'tracking_ref'), label = text(fields, 'label_ref');
    if (!tracking && !label) throw new Error('Enter a tracking reference or a label reference before dispatch.');
    return request(`/shipments/${detail.shipment_id}/dispatch`, { carrier: text(fields, 'carrier'), as_of: text(fields, 'as_of'), ...(tracking ? { tracking_ref: tracking } : {}), ...(label ? { label_ref: label } : {}) });
  }, 'Shipment dispatched. Inventory and reservations have been updated.');
  bindForm('tracking-form', fields => {
    if (!detail || detail.status === 'draft') throw new Error('Dispatch the shipment before adding a carrier update.');
    const stamp = new Date(text(fields, 'occurred_at'));
    if (Number.isNaN(stamp.getTime())) throw new Error('Enter a valid update date and time.');
    return request(`/shipments/${detail.shipment_id}/events`, { event: text(fields, 'event'), occurred_at: stamp.toISOString(), ...(text(fields, 'detail') ? { detail: text(fields, 'detail') } : {}) });
  }, 'Carrier update saved. Inventory is unchanged.');
}

async function loadWorkspace() {
  loading = true;
  message = '';
  failed = false;
  render();
  try { await refresh(); }
  catch (error) {
    message = error instanceof Error ? error.message : 'Could not load shipping.';
    failed = true;
  } finally { loading = false; render(); }
}

void loadWorkspace();
