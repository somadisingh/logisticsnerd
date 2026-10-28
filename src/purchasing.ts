import '@fontsource-variable/dm-sans';
import './styles.css';
import './purchasing.css';
import { demoNavigation } from './demo-navigation';

type Row = Record<string, unknown>;
interface Binding extends Row { id: number; kind: string; external_key: string; snapshot: Row; valid_to: string | null; }
interface Demand extends Row { id: number; external_key: string; order_ref: string; item_id: number; quantity: number; currency: string; }
interface Quote extends Row { id: number; supplier_id: number; item_id: number; quantity_priced: number; price_minor: number; currency: string; }
interface Purchase extends Row { id: number; supplier_id: number; status: string; currency: string; version: number; }
interface Line extends Row { id: number; purchase_order_id: number; item_id: number; quantity: number; }
interface Allocation extends Row { id: number; po_line_id: number; demand_line_id: number; quantity: number; }
interface Workspace { references: Binding[]; demands: Demand[]; quotes: Quote[]; purchase_orders: Purchase[]; purchase_lines: Line[]; allocations: Allocation[]; stock: Row[]; }

const app = document.querySelector<HTMLDivElement>('#app')!;
const endpoint = '/api/purchasing';
let token = '';
let data: Workspace | undefined;
let busy = false;
let progress: Row | undefined;
let message = '';
let failed = false;
// Pending request identities survive network failures while this page remains open.
// Refreshing the page clears them. A delivery_ref also identifies physical goods.
const pending = new Map<string, string>();
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const field = (name: string, label: string, type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" required ${extra}></label>`;
const options = (rows: Row[], label: (row: Row) => string) => rows.map(row => `<option value="${escape(row.id)}">${escape(label(row))}</option>`).join('');
const select = (name: string, label: string, rows: Row[], format: (row: Row) => string) => `<label>${label}<select name="${name}" required><option value="">Select…</option>${options(rows, format)}</select></label>`;
const refs = (kind: string) => data?.references.filter(ref => ref.kind === kind && !ref.valid_to) ?? [];
const referenceName = (id: unknown) => {
  const ref = data?.references.find(binding => binding.id === Number(id));
  return String(ref?.snapshot?.name ?? ref?.snapshot?.label ?? ref?.external_key ?? `#${id}`);
};
const sameSupplier = (left: unknown, right: unknown) => {
  const a = data?.references.find(r => r.id === Number(left));
  const b = data?.references.find(r => r.id === Number(right));
  return Boolean(a && b && a.kind === 'supplier' && b.kind === 'supplier' && a.external_key === b.external_key);
};
const number = (form: FormData, name: string) => Number(form.get(name));
const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const dateNow = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; };
const button = (label: string) => `<button class="purchasing-button" ${busy ? 'disabled' : ''}>${label}</button>`;

async function request(path: string, body?: Row): Promise<unknown> {
  const identity = `${path}:${JSON.stringify(body)}`;
  let key: string | undefined;
  if (body) {
    key = pending.get(identity) ?? crypto.randomUUID();
    pending.set(identity, key);
  }
  const response = await fetch(`${endpoint}${path}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify({ ...body, idempotency_key: key }) } : {}),
  });
  const value = await response.json() as { error?: { message?: string; fields?: { location: unknown[]; message: string }[] }; detail?: string };
  if (!response.ok) {
    const fields = value.error?.fields?.map(issue => `${issue.location.slice(1).join('.')}: ${issue.message}`).join('; ');
    throw new Error(fields || value.error?.message || value.detail || 'The request failed.');
  }
  if (body) pending.delete(identity);
  return value;
}

async function refresh() { data = await request('/workspace') as Workspace; }

function table(headers: string[], rows: unknown[][]) {
  if (!rows.length) return '<p class="purchasing-empty">No records yet.</p>';
  return `<div class="purchasing-table-wrap"><table class="purchasing-table"><thead><tr>${headers.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function progressReport() {
  if (!progress || !Array.isArray(progress.lines)) return '<p>Choose a purchase to read its current received and outstanding quantities.</p>';
  const lines = progress.lines as Row[];
  return `<h3>Purchase #${escape(progress.id)} · ${escape(progress.status)}</h3>${table(['Line','Ordered','Received','Outstanding'], lines.map(line => [line.id,line.quantity,line.received_quantity,line.outstanding_quantity]))}${lines.map(line => {
    const allocations = Array.isArray(line.allocations) ? line.allocations as Row[] : [];
    return allocations.length ? `<h3>Customer allocations for line #${escape(line.id)}</h3>${table(['Customer line','Allocated','Received','Outstanding'],allocations.map(a=>[a.demand_line_id,a.quantity,a.received_quantity,a.outstanding_quantity]))}` : '';
  }).join('')}`;
}

function render() {
  const loaded = Boolean(data);
  const draft = data?.purchase_orders.filter(po => po.status === 'draft') ?? [];
  const approved = data?.purchase_orders.filter(po => po.status === 'approved') ?? [];
  const draftLines = data?.purchase_lines.filter(line => draft.some(po => po.id === line.purchase_order_id)) ?? [];
  app.innerHTML = `<main class="purchasing-page">${demoNavigation('purchasing')}<header class="purchasing-header"><div><div class="eyebrow">PURCHASING WORKSPACE</div><h1>From quote to receipt.</h1><p>Save supplier terms, approve purchases and receive deliveries. Approval commits the purchase; stock changes only when goods arrive.</p></div>${loaded ? '<button class="purchasing-button secondary" id="disconnect">Disconnect</button>' : ''}</header>
    <div class="purchasing-message${failed ? ' error' : ''}" role="status" aria-live="polite">${escape(message)}</div>
    ${!loaded ? `<section class="purchasing-panel purchasing-lock"><h2>Connect to your workspace</h2><p>Enter the local owner development token from your ignored environment file. It stays in this page’s memory and clears when the page closes.</p><form id="connect"><div class="purchasing-fields">${field('token', 'Owner development token', 'password', 'autocomplete="off" spellcheck="false"')}</div>${button('Connect')}</form><p>Backend setup: <code>docs/purchasing/setup.md</code></p></section>` : `
    <p class="purchasing-connection">Connected to the configured business database · Owner development access</p>
    <div class="purchasing-grid">
      <section class="purchasing-panel purchasing-wide"><h2>Customer demand</h2>${table(['Line', 'Order', 'Item', 'Ordered', 'Reserved', 'Inbound', 'Remaining to buy', 'Currency'], data!.demands.map(d => [d.id, d.order_ref, referenceName(d.item_id), d.quantity, d.reserved_quantity, d.inbound_quantity, d.remaining_to_buy, d.currency]))}</section>
      <section class="purchasing-panel"><h2>1. Record a supplier quote</h2><p>Each saved version preserves its terms. Amounts below are integer minor units: 100 means 1.00.</p><form id="quote"><div class="purchasing-fields">${select('supplier_id','Supplier',refs('supplier'),r=>referenceName(r.id))}${select('item_id','Item',refs('item'),r=>referenceName(r.id))}${field('quantity_priced','Priced quantity','number','min="1" step="1"')}${field('capacity_quantity','Available quantity','number','min="1" step="1"')}${field('price_minor','Unit price in minor units','number','min="0" step="1"')}${field('currency','Currency','text','pattern="[A-Z]{3}" maxlength="3" value="USD"')}${field('expected_date','Expected delivery date','date')}${field('expires_at','Quote expiry','datetime-local')}</div>${button('Save quote version')}</form></section>
      <section class="purchasing-panel"><h2>2. Create a purchase draft</h2><p>Choose one supplier for this purchase. Add lines and customer allocations below.</p><form id="draft"><div class="purchasing-fields">${select('supplier_id','Supplier',refs('supplier'),r=>referenceName(r.id))}${field('currency','Currency','text','pattern="[A-Z]{3}" maxlength="3" value="USD"')}</div>${button('Create draft')}</form><h3>Available quote versions</h3>${table(['Quote', 'Supplier', 'Item', 'Quantity', 'Price'], data!.quotes.map(q => [q.id, referenceName(q.supplier_id), referenceName(q.item_id), q.quantity_priced, `${q.price_minor} ${q.currency}`]))}</section>
      <section class="purchasing-panel"><h2>3. Add a purchase line</h2><p>The quote must belong to the purchase’s supplier and currency. Use the exact priced quantity.</p><form id="line"><div class="purchasing-fields">${select('purchase_order_id','Draft purchase',draft,r=>`PO #${r.id} · ${referenceName(r.supplier_id)}`)}${select('quote_version_id','Quote version',data!.quotes,r=>`#${r.id} · ${referenceName(r.supplier_id)} · ${referenceName(r.item_id)}`)}${field('quantity','Quantity','number','min="1" step="1"')}</div>${button('Add line')}</form></section>
      <section class="purchasing-panel"><h2>4. Allocate to a customer</h2><p>A purchase line can supply several customer lines. This interface keeps each customer shortage with one supplier; the data model also supports split sourcing.</p><form id="allocation"><div class="purchasing-fields">${select('po_line_id','Draft purchase line',draftLines,r=>`Line #${r.id} · PO #${r.purchase_order_id} · ${referenceName(r.item_id)}`)}${select('demand_line_id','Customer line',data!.demands,r=>`#${r.id} · ${r.order_ref} · ${referenceName(r.item_id)}`)}${field('quantity','Allocated quantity','number','min="1" step="1"')}<label>Cost share in minor units (if required)<input name="cost_share_minor" type="number" min="0" step="1"></label></div>${button('Save allocation')}</form></section>
      <section class="purchasing-panel purchasing-wide"><h2>5. Review and approve</h2><p>Approval freezes the purchase terms and allocations. It adds no stock. Approved amendments and cancellation need a separate policy.</p>${table(['PO', 'Supplier', 'Currency', 'Status'], data!.purchase_orders.map(po => [po.id, referenceName(po.supplier_id), po.currency, po.status]))}<h3>Purchase lines</h3>${table(['Line','PO','Item','Quantity'],data!.purchase_lines.map(l=>[l.id,l.purchase_order_id,referenceName(l.item_id),l.quantity]))}<h3>Customer allocations</h3>${table(['Allocation','Purchase line','Customer line','Quantity'],data!.allocations.map(a=>[a.id,a.po_line_id,a.demand_line_id,a.quantity]))}<form id="approve"><div class="purchasing-fields">${select('purchase_order_id','Draft purchase to approve',draft,r=>`PO #${r.id} · ${referenceName(r.supplier_id)}`)}</div>${button('Approve purchase')}</form></section>
      <section class="purchasing-panel purchasing-wide"><h2>6. Receive a whole delivery</h2><p>Enter the actual received portions. Each portion can reserve stock for several waiting customer lines. All portions and reservations save together. Reuse the same delivery reference for the same physical delivery.</p><form id="delivery"><div class="purchasing-fields">${field('delivery_ref','Delivery / supplier document reference')}${field('received_on','Received date','date',`value="${dateNow()}"`)}</div><div id="receipt-portions"></div><button type="button" class="purchasing-button secondary" id="add-portion">Add received portion</button><p>Each row is physical stock received once. Allocations divide that quantity; they do not create additional stock.</p>${button('Record delivery and reservations')}</form></section>
      <section class="purchasing-panel"><h2>Purchase progress</h2><form id="progress"><div class="purchasing-fields">${select('purchase_order_id','Purchase order',data!.purchase_orders,r=>`PO #${r.id} · ${r.status}`)}</div>${button('Read progress')}</form>${progressReport()}</section>
      <section class="purchasing-panel"><h2>Stock by location</h2>${table(['Item','Location','On hand','Reserved','Available'],data!.stock.map(s=>[referenceName(s.item_id),referenceName(s.location_id),s.on_hand,s.reserved,s.available]))}</section>
    </div><p class="purchasing-note">Current workspace uses explicit core-reference bindings. Production item and entity mapping still requires the authoritative OperationsNerd adapter.</p>`}
  </main>`;
  bind();
  if (loaded && approved.length) addPortion();
}

function addPortion() {
  if (!data) return;
  const approved = data.purchase_orders.filter(po => po.status === 'approved');
  const lines = data.purchase_lines.filter(line => approved.some(po => po.id === line.purchase_order_id));
  const container = document.createElement('fieldset');
  container.className = 'purchasing-panel';
  container.innerHTML = `<legend>Received portion</legend><div class="purchasing-fields">${select('po_line_id','Approved PO line',lines,r=>`Line #${r.id} · PO #${r.purchase_order_id} · ${referenceName(r.item_id)}`)}${select('location_id','Stock location',refs('location'),r=>referenceName(r.id))}${field('quantity','Physical quantity received','number','min="1" step="1"')}<label>Lot number (optional)<input name="lot_number"></label><label>Expiry date (optional)<input name="expiry_date" type="date"></label></div><label>Reservation splits (one per line: allocation ID, customer line ID, quantity)<textarea name="allocations" placeholder="12, 5, 3&#10;13, 6, 2" aria-label="Reservation splits"></textarea></label><p>Leave splits empty to receive free stock.</p><button type="button" class="purchasing-button secondary" data-remove-portion>Remove portion</button>`;
  container.querySelector('[data-remove-portion]')?.addEventListener('click', () => container.remove());
  document.querySelector('#receipt-portions')?.append(container);
}

async function submit(form: HTMLFormElement, work: (fields: FormData) => Promise<unknown>, success: string) {
  if (busy) return;
  busy = true;
  form.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = true);
  try {
    const value = await work(new FormData(form));
    await refresh();
    if (value && typeof value === 'object' && 'lines' in value && 'status' in value) progress = value as Row;
    message = success; failed = false;
    render();
  } catch (error) {
    message = error instanceof Error ? error.message : 'The request failed.';
    failed = true;
    const feedback = document.querySelector('.purchasing-message')!;
    feedback.textContent = message;
    feedback.classList.add('error');
    form.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false);
  } finally {
    busy = false;
    document.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false);
  }
}

function bindForm(id: string, work: (fields: FormData) => Promise<unknown>, success: string) {
  const form = document.querySelector<HTMLFormElement>(`#${id}`);
  form?.addEventListener('submit', event => { event.preventDefault(); void submit(form, work, success); });
}

function bind() {
  bindForm('connect', async f => { token = text(f,'token'); return refresh(); }, 'Connected. Changes are saved in the configured database.');
  document.querySelector('#disconnect')?.addEventListener('click', () => { token = ''; data = undefined; pending.clear(); progress = undefined; message = ''; render(); });
  bindForm('quote', f => request('/quotes', { supplier_id:number(f,'supplier_id'), item_id:number(f,'item_id'), quantity_priced:number(f,'quantity_priced'),capacity_quantity:number(f,'capacity_quantity'),price_minor:number(f,'price_minor'),pricing_kind:'unit',currency:text(f,'currency'),expected_date:text(f,'expected_date'),expires_at:new Date(text(f,'expires_at')).toISOString() }), 'Quote version saved.');
  bindForm('draft', f => request('/orders',{supplier_id:number(f,'supplier_id'),currency:text(f,'currency')}),'Purchase draft saved.');
  bindForm('line', f => { const po = data!.purchase_orders.find(p=>p.id===number(f,'purchase_order_id'))!; return request(`/orders/${po.id}/lines`,{quote_version_id:number(f,'quote_version_id'),quantity:number(f,'quantity'),expected_version:po.version}); },'Purchase line saved.');
  bindForm('allocation', f => { const line = data!.purchase_lines.find(l=>l.id===number(f,'po_line_id'))!; const po=data!.purchase_orders.find(p=>p.id===line.purchase_order_id)!; return request(`/lines/${line.id}/allocations`,{demand_line_id:number(f,'demand_line_id'),quantity:number(f,'quantity'),expected_version:po.version,...(text(f,'cost_share_minor') ? {cost_share_minor:number(f,'cost_share_minor')} : {})}); },'Allocation saved.');
  bindForm('approve', f => { const po = data!.purchase_orders.find(p=>p.id===number(f,'purchase_order_id'))!; return request(`/orders/${po.id}/approve`,{expected_version:po.version}); },'Purchase approved. Stock is unchanged.');
  bindForm('progress', f => request(`/orders/${number(f,'purchase_order_id')}/progress`),'Progress calculated from receipt records.');
  const purchaseSelect = document.querySelector<HTMLSelectElement>('#line [name="purchase_order_id"]');
  purchaseSelect?.addEventListener('change', () => {
    const po = data!.purchase_orders.find(p => p.id === Number(purchaseSelect.value));
    const quoteSelect = document.querySelector<HTMLSelectElement>('#line [name="quote_version_id"]')!;
    const available = data!.quotes.filter(q => sameSupplier(q.supplier_id, po?.supplier_id) && q.currency === po?.currency);
    quoteSelect.innerHTML = '<option value="">Select…</option>' + options(available, q => `#${q.id} · ${referenceName(q.item_id)} · ${q.quantity_priced} units`);
  });
  document.querySelector<HTMLSelectElement>('#line [name="quote_version_id"]')?.addEventListener('change', event => {
    const quote = data!.quotes.find(q => q.id === Number((event.target as HTMLSelectElement).value));
    const quantity = document.querySelector<HTMLInputElement>('#line [name="quantity"]')!;
    quantity.value = quote ? String(quote.quantity_priced) : '';
  });
  const allocationLine = document.querySelector<HTMLSelectElement>('#allocation [name="po_line_id"]');
  allocationLine?.addEventListener('change', () => {
    const line = data!.purchase_lines.find(l => l.id === Number(allocationLine.value));
    const po = data!.purchase_orders.find(p => p.id === line?.purchase_order_id);
    const available = data!.demands.filter(demand => demand.item_id === line?.item_id && !data!.allocations.some(allocation => {
      if (allocation.demand_line_id !== demand.id) return false;
      const allocatedLine = data!.purchase_lines.find(l => l.id === allocation.po_line_id);
      const allocatedOrder = data!.purchase_orders.find(p => p.id === allocatedLine?.purchase_order_id);
      return !sameSupplier(allocatedOrder?.supplier_id, po?.supplier_id);
    }));
    document.querySelector<HTMLSelectElement>('#allocation [name="demand_line_id"]')!.innerHTML = '<option value="">Select…</option>' + options(available, d => `#${d.id} · ${d.order_ref} · ${referenceName(d.item_id)}`);
  });
  document.querySelector('#add-portion')?.addEventListener('click',addPortion);
  bindForm('delivery', f => {
    const portions = [...document.querySelectorAll<HTMLFieldSetElement>('#receipt-portions fieldset')];
    if (!portions.length) throw new Error('Add at least one received portion.');
    const lines = portions.map(portion => {
      const read = (name:string) => (portion.querySelector(`[name="${name}"]`) as HTMLInputElement|HTMLTextAreaElement).value.trim();
      const poLine = data!.purchase_lines.find(l=>l.id===Number(read('po_line_id')))!;
      const allocations=read('allocations').split('\n').filter(s=>s.trim()).map(row=>{
        const parts=row.split(',').map(v=>Number(v.trim()));
        if(parts.length!==3 || parts.some(n=>!Number.isSafeInteger(n)||n<=0)) throw new Error('Use allocation ID, customer line ID, quantity for each reservation split.');
        return {purchase_allocation_id:parts[0],demand_line_id:parts[1],quantity:parts[2]};
      });
      return {po_line_id:poLine.id,item_id:poLine.item_id,location_id:Number(read('location_id')),quantity:Number(read('quantity')),allocations,...(read('lot_number')?{lot_number:read('lot_number')} : {}),...(read('expiry_date')?{expiry_date:read('expiry_date')} : {})};
    });
    return request('/deliveries',{delivery_ref:text(f,'delivery_ref'),received_on:text(f,'received_on'),lines});
  },'Delivery recorded. All receipt portions and reservations were committed together.');
}

render();
