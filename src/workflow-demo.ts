import '@fontsource-variable/dm-sans';
import './styles.css';
import './workflow-demo.css';
import { brandMark, icon } from './icons';
import { dateLabel, money } from './domain/reasons';
import { getSnapshot, sendAction, type Snapshot, type WorkflowAction } from './workflow-client';

const app = document.querySelector<HTMLDivElement>('#app')!;
let snapshot: Snapshot | null = null;
let busy = false;
let message = '';
let failed = false;

const escape = (value: string | number): string => String(value).replace(/[&<>"']/g,
  (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

function button(action: WorkflowAction, label: string, options: { disabled?: boolean; secondary?: boolean } = {}): string {
  return `<button type="button" data-action="${action}" class="button ${options.secondary ? 'button-secondary' : 'button-primary'}" ${busy || options.disabled ? 'disabled' : ''}>${label}</button>`;
}

function header(): string {
  return `<header class="header workflow-header">
    <a class="brand" href="/" aria-label="LogisticsNerd home">${brandMark}<span>logistics<span class="brand-light">nerd</span><span class="brand-dot">.</span></span></a>
    <nav class="workflow-nav" aria-label="Demos"><a href="/" aria-current="page">Order workflow</a><a href="/supplier-comparison.html">Supplier comparison</a></nav>
    <button type="button" class="reset-button" data-action="reset" ${busy ? 'disabled' : ''}>${icon('reset')}Reset demo</button>
  </header>`;
}

function metrics(state: Snapshot): string {
  const values = [
    { label: 'On hand', value: state.stock.on_hand, test: 'on-hand', detail: 'Physical stock', symbol: 'box' },
    { label: 'Reserved', value: state.stock.reserved, test: 'reserved', detail: 'Across unfinished orders', symbol: 'shield' },
    { label: 'Available', value: state.stock.available, test: 'available', detail: 'On hand minus reserved', symbol: 'list' },
    { label: 'Approved inbound', value: state.lines[0]?.shortage.approved_inbound ?? 0, test: 'inbound', detail: 'Assigned to this order', symbol: 'clock' },
  ];
  return `<section class="workflow-metrics" aria-label="Current inventory">${values.map((metric) => `<div class="workflow-metric">
    <div><span>${metric.label}</span>${icon(metric.symbol)}</div><strong data-testid="${metric.test}">${metric.value}</strong><small>${metric.detail}</small>
  </div>`).join('')}</section>`;
}

function progress(state: Snapshot): string {
  const line = state.lines[0];
  const stage = !state.order || line?.original_shortage === null ? 0
    : !state.recommendation ? 1 : !state.purchases.length ? 2 : state.order.status !== 'fulfilled' ? 3 : 4;
  const steps = ['Reserve stock', 'Compare suppliers', 'Approve purchases', 'Receive & fulfill'];
  return `<ol class="workflow-progress" aria-label="Order progress">${steps.map((label, index) => `<li class="${index < stage ? 'complete' : index === stage ? 'active' : ''}" ${index === stage ? 'aria-current="step"' : ''}><span>${index < stage ? icon('check') : `0${index + 1}`}</span>${label}</li>`).join('')}</ol>`;
}

function orderPanel(state: Snapshot): string {
  const order = state.order;
  const line = state.lines[0];
  const shortage = line?.shortage;
  const fulfilled = order?.status === 'fulfilled';
  const status = fulfilled ? 'Fulfilled' : order?.status === 'ready' ? 'Ready to fulfill' : !order ? 'Prepared scenario' : 'Open';
  const reserved = shortage?.reserved ?? 0;
  const demand = state.scenario.quantity;
  const covered = fulfilled ? demand : reserved;
  const lineState = !order ? 'Create the order to begin.' : fulfilled ? `${demand} units fulfilled. Reservations for this order are released.`
    : line.original_shortage === null ? 'Reserve the stock that is available.'
    : shortage.quantity_to_purchase > 0 ? `${shortage.quantity_to_purchase} units still need a purchase allocation.`
    : shortage.approved_inbound > 0 ? `${shortage.approved_inbound} units are approved and awaiting receipt.` : 'Every unit is reserved. The order is ready.';
  return `<section class="panel workflow-order" aria-labelledby="order-title">
    <div class="panel-heading"><div><div class="section-kicker">COMPANY A · CUSTOMER ORDER</div><h2 class="section-title" id="order-title">${escape(state.item.name)}</h2><p>${escape(state.item.sku)} · Required by ${dateLabel(state.deadline, true)}</p></div><span class="workflow-status ${fulfilled || order?.status === 'ready' ? 'is-ready' : ''}" data-testid="order-status">${status}</span></div>
    <div class="workflow-demand"><div><span>Customer demand</span><strong>${demand} <small>units</small></strong></div><div><span>Reserved for this order</span><strong data-testid="customer-reserved">${reserved}</strong></div><div><span>Remaining to purchase</span><strong data-testid="shortage">${fulfilled ? 0 : shortage?.quantity_to_purchase ?? '—'}</strong></div></div>
    <div class="workflow-coverage"><div class="workflow-meter" role="progressbar" aria-label="Customer order coverage" aria-valuenow="${covered}" aria-valuemin="0" aria-valuemax="${demand}"><span style="width:${covered / demand * 100}%"></span></div><p>${icon(fulfilled ? 'checkCircle' : 'info')}${lineState}</p></div>
    <div class="workflow-order-footer"><span>${icon('shield')}${state.other_order.reserved_quantity} units stay reserved for another order.</span>${!order ? button('create_order', `Create order ${icon('arrow')}`) : line.original_shortage === null ? button('reserve', `Reserve available stock ${icon('arrow')}`) : `<span class="workflow-small-note">Original shortage: ${shortage.original_shortage} units</span>`}</div>
  </section>`;
}

function supplierPanel(state: Snapshot): string {
  const compared = !!state.recommendation;
  const approved = state.purchases.length > 0;
  const reserved = state.lines[0]?.original_shortage !== null && !!state.order;
  const originalShortage = state.lines[0]?.original_shortage ?? state.scenario.quantity - state.stock.available;
  return `<section class="panel workflow-suppliers" aria-labelledby="supplier-title">
    <div class="panel-heading"><div><div class="section-kicker">SOURCING THE SHORTAGE</div><h2 class="section-title" id="supplier-title">Cover the remaining shortage.</h2><p>Neither supplier can cover ${originalShortage} units alone.</p></div><span class="workflow-source">Synthetic estimates</span></div>
    <div class="workflow-supplier-grid">${state.suppliers.map((supplier) => {
      const quote = state.quotes.find((value) => value.supplier_id === supplier.id);
      const capacity = quote?.capacity_quantity ?? supplier.capacity_quantity;
      const priced = quote?.quantity_priced ?? supplier.quantity_priced;
      const price = quote?.price_cents ?? supplier.unit_price_cents;
      const delivery = quote?.expected_date ?? supplier.expected_date;
      const allocation = state.recommendation?.allocations.find((value) => value.quote_id === quote?.id);
      const purchase = state.purchases.find((value) => value.supplier_id === supplier.id);
      return `<article class="workflow-supplier ${compared ? 'is-selected' : ''}">
        <div class="workflow-supplier-title"><span class="supplier-avatar">${escape(supplier.id)}</span><h3>${escape(supplier.name)}</h3>${compared ? `<span class="workflow-selected">${icon('check')}Selected</span>` : ''}</div>
        <div class="workflow-price"><strong>${money(price)}</strong><span>per unit · USD</span></div>
        <dl><div><dt>Capacity</dt><dd>${capacity} units</dd></div><div><dt>Quantity priced</dt><dd>${priced} units</dd></div><div><dt>Delivery</dt><dd>${dateLabel(delivery, true)}</dd></div></dl>
        <div class="workflow-supplier-allocation"><span>${approved ? 'Purchased' : compared ? 'Recommended' : 'Available to allocate'}</span><strong>${purchase?.quantity ?? allocation?.quantity ?? capacity} units <span>· ${money(purchase?.total_cents ?? allocation?.total_cents ?? priced * price)}</span></strong></div>
      </article>`;
    }).join('')}</div>
    ${compared ? `<div class="workflow-plan"><div>${icon('checkCircle')}<span><strong>${money(state.recommendation!.total_cents)} combined purchase</strong><small>${state.recommendation!.allocations.reduce((sum, value) => sum + value.quantity, 0)} units · Delivery by ${dateLabel(state.deadline)} · Within the ${money(state.budget_cents)} purchase budget</small></span></div><span class="workflow-budget">${money(state.budget_cents - state.recommendation!.total_cents)} under budget</span></div>` : ''}
    <div class="workflow-sourcing-action">${approved ? `<div class="workflow-approved">${icon('checkCircle')}<span><strong>Both purchases approved</strong><small>Company A demo owner · On-hand stock stayed at 6</small></span></div>` : compared ? `<div class="workflow-approval-copy"><strong>Approve 7 units from X and 4 from Y</strong><span>Creates two purchase orders for ${money(state.recommendation!.total_cents)}. Approval does not add stock.</span><small>Approver: Company A demo owner</small></div>${button('approve', `Approve both purchases ${icon('check')}`)}` : `<p>${reserved ? 'Compare quantity, delivery and combined cost. This creates no purchases.' : 'Reserve available stock before comparing the remaining shortage.'}</p>${button('compare', `Compare suppliers ${icon('arrow')}`, { disabled: !reserved })}`}</div>
  </section>`;
}

function receivingPanel(state: Snapshot): string {
  if (!state.purchases.length) return '';
  const received = state.purchases.filter((value) => value.status === 'received').length;
  const fulfilled = state.order?.status === 'fulfilled';
  return `<section class="panel workflow-receiving" aria-labelledby="receiving-title">
    <div class="panel-heading"><div><div class="section-kicker">RECEIVING & FULFILLMENT</div><h2 class="section-title" id="receiving-title">${fulfilled ? 'Order fulfilled.' : received === 2 ? 'All goods received.' : 'Receive each purchase.'}</h2><p>${fulfilled ? '15 units consumed. The other order keeps its reservation.' : 'Each receipt adds stock and reserves it for this customer.'}</p></div><span class="workflow-count">${received} / 2 received</span></div>
    <div class="workflow-receipt-list">${state.purchases.map((purchase) => `<div class="workflow-receipt"><span class="workflow-receipt-icon ${purchase.status === 'received' ? 'is-received' : ''}">${icon(purchase.status === 'received' ? 'check' : 'box')}</span><div><strong>Supplier ${escape(purchase.supplier_id)} · ${purchase.quantity} units</strong><small>${money(purchase.total_cents)} · ${purchase.status === 'received' ? 'Received in full' : 'Approved · Awaiting full receipt'}</small></div>${button(purchase.supplier_id === 'X' ? 'receive_x' : 'receive_y', purchase.status === 'received' ? 'Received' : `Receive ${purchase.quantity} units`, { disabled: purchase.status === 'received', secondary: true })}</div>`).join('')}</div>
    <div class="workflow-fulfillment ${fulfilled ? 'is-fulfilled' : ''}"><div><strong>${fulfilled ? 'Fulfillment complete' : received === 2 ? 'Ready to fulfill all 15 units' : 'Waiting for all 15 units'}</strong><p>${fulfilled ? 'Final stock: 2 units, still reserved for the other order.' : received === 2 ? 'Consume this order’s stock and release its reservations together.' : 'Try fulfillment now to see the incomplete order rejected.'}</p></div>${fulfilled ? `<span class="workflow-complete">${icon('checkCircle')}Fulfilled</span>` : button('fulfill', received === 2 ? `Fulfill order ${icon('arrow')}` : 'Try fulfillment', { secondary: received !== 2 })}</div>
  </section>`;
}

function sidebar(state: Snapshot): string {
  const fulfilled = state.order?.status === 'fulfilled';
  return `<aside class="workflow-sidebar">
    <section class="workflow-scenario"><div class="section-kicker">THE PREPARED SCENARIO</div><h2>15 ordered.<br> 4 available.</h2><p>Start with 6 units on hand. Another order already holds 2. Cover the remaining 11 with two suppliers.</p><dl><div><dt>Company</dt><dd>Company A</dd></div><div><dt>Stock location</dt><dd>One</dd></div><div><dt>Currency</dt><dd>USD</dd></div><div><dt>Purchase budget</dt><dd>${money(state.budget_cents)}</dd></div></dl><div class="workflow-scenario-note">${icon('info')}Supplier quantities, prices and dates are synthetic.</div></section>
    <section class="panel workflow-checks"><div class="section-kicker">CHECK THE GUARANTEES</div><h2>Repeat it. Keep the stock.</h2><p>Completed receipts and fulfillment must not post twice.</p>${button('replay', 'Replay completed actions', { disabled: !fulfilled, secondary: true })}<p>Company B must be unable to use these Company A records.</p>${button('check_isolation', 'Check company isolation', { disabled: !state.order, secondary: true })}<small>Fixture company checks. Core authentication is not connected.</small></section>
    <section class="panel workflow-activity" aria-labelledby="activity-title"><div class="workflow-activity-heading"><h2 id="activity-title">Demo activity</h2><span>${state.events.length} actions</span></div>${state.events.length ? `<ol>${[...state.events].reverse().map((event) => `<li class="${event.ok ? '' : 'is-error'}"><span class="workflow-event-icon">${icon(event.ok ? 'check' : 'info')}</span><div><strong>${escape(event.label)}</strong><p>${escape(event.detail)}</p></div></li>`).join('')}</ol>` : '<p class="workflow-no-activity">Create the customer order to start.</p>'}</section>
  </aside>`;
}

function render(): void {
  app.setAttribute('aria-busy', String(busy));
  app.innerHTML = `${header()}<main class="page workflow-page">
    <section class="intro workflow-intro"><div><div class="eyebrow"><span class="eyebrow-line"></span>ORDER WORKFLOW</div><h1>From order<br><span>to fulfillment.</span></h1><p class="intro-copy">Reserve stock. Cover the shortage. Approve purchases.<br class="desktop-break"> Receive the goods, then fulfill the customer order.</p></div><div class="workflow-demo-note"><span class="demo-badge"><span></span>In-memory demo</span><p>Synthetic supplier data<br> No suppliers contacted</p></div></section>
    ${snapshot ? `${metrics(snapshot)}${progress(snapshot)}` : ''}
    <div class="workflow-feedback ${failed ? 'is-error' : ''}" role="${failed ? 'alert' : 'status'}" tabindex="-1" ${!message ? 'hidden' : ''}>${icon(failed ? 'info' : 'checkCircle')}<span>${escape(message)}</span></div>
    ${snapshot ? `<div class="workflow-layout"><div class="workflow-main">${orderPanel(snapshot)}${supplierPanel(snapshot)}${receivingPanel(snapshot)}</div>${sidebar(snapshot)}</div>` : `<section class="panel workflow-loading"><h2>${failed ? 'The demo is unavailable.' : 'Loading the demo…'}</h2><p>${failed ? 'Start the local app with npm run dev, then retry.' : 'Preparing Company A’s stock and synthetic suppliers.'}</p>${failed ? '<button type="button" data-retry class="button button-primary">Retry connection</button>' : ''}</section>`}
    <footer class="footer workflow-footer"><span>${icon('box')}LogisticsNerd · OperationsNerd module demo</span><span>One local demo session · Resets on server restart · No database connection</span></footer>
  </main>`;
}

async function load(): Promise<void> {
  busy = true;
  failed = false;
  message = '';
  render();
  try { snapshot = await getSnapshot(); }
  catch (error) { failed = true; message = (error as Error).message; }
  finally { busy = false; render(); }
}

async function act(action: WorkflowAction): Promise<void> {
  if (busy) return;
  busy = true;
  message = '';
  render();
  try {
    const result = await sendAction(action);
    snapshot = result.snapshot;
    failed = !result.ok;
    message = result.error ?? snapshot.events.at(-1)?.detail ?? 'Demo reset.';
  } catch (error) { failed = true; message = (error as Error).message; }
  finally {
    busy = false;
    render();
    if (failed) {
      const feedback = app.querySelector<HTMLElement>('.workflow-feedback');
      feedback?.focus({ preventScroll: true });
      feedback?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    } else {
      const next = app.querySelector<HTMLButtonElement>(`[data-action="${action}"]:not(:disabled)`)
        ?? app.querySelector<HTMLButtonElement>('.workflow-main .button-primary:not(:disabled)')
        ?? app.querySelector<HTMLButtonElement>('.workflow-main button:not(:disabled), [data-action="replay"]:not(:disabled)');
      next?.focus({ preventScroll: true });
    }
  }
}

app.addEventListener('click', (event) => {
  const target = (event.target as Element).closest<HTMLButtonElement>('button');
  if (!target || target.disabled) return;
  if (target.hasAttribute('data-retry')) void load();
  const action = target.dataset.action;
  if (action) void act(action as WorkflowAction);
});

void load();
