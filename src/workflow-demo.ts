import '@fontsource-variable/dm-sans';
import './styles.css';
import './workflow-demo.css';
import { brandMark, icon } from './icons';
import { estimateStatus } from './estimates-client';
import { parseMoney } from './domain/validate';
import { dateLabel, money } from './domain/reasons';
import { getSnapshot, sendAction, type Snapshot, type WorkflowAction } from './workflow-client';

const app = document.querySelector<HTMLDivElement>('#app')!;
let snapshot: Snapshot | null = null;
let busy = false;
let message = '';
let failed = false;
let aiConfigured: boolean | null = null;
let budgetDraft = '20.00';

const escape = (value: string | number): string => String(value).replace(/[&<>"']/g,
  (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

function button(action: WorkflowAction, label: string, options: { disabled?: boolean; secondary?: boolean; supplierId?: string } = {}): string {
  return `<button type="button" data-action="${action}" ${options.supplierId ? `data-supplier="${escape(options.supplierId)}"` : ''} class="button ${options.secondary ? 'button-secondary' : 'button-primary'}" ${busy || options.disabled ? 'disabled' : ''}>${label}</button>`;
}

function header(): string {
  return `<header class="header workflow-header">
    <a class="brand" href="/" aria-label="LogisticsNerd home">${brandMark}<span>logistics<span class="brand-light">nerd</span><span class="brand-dot">.</span></span></a>
    <nav class="workflow-nav" aria-label="Demos"><a href="/" aria-current="page">Order workflow</a><a href="/supplier-comparison.html">Supplier comparison</a></nav>
    <button type="button" class="reset-button" data-action="reset" ${busy ? 'disabled' : ''}>${icon('reset')}Reset demo</button>
  </header>`;
}

function sourcePanel(state: Snapshot): string {
  const ai = state.source === 'ai';
  return `<section class="workflow-source-picker" aria-label="Supplier data source"><div><strong>Supplier estimates</strong><p>${ai ? 'Baseten generates hypothetical offers. Python checks quantity, delivery and budget.' : 'Prepared prices and quantities reproduce the 7 + 4 split.'}</p></div><div class="workflow-source-buttons">${button('use_sample', 'Prepared sample', { secondary: ai, disabled: !ai })}${button('use_ai', 'AI estimates · Baseten', { secondary: !ai, disabled: ai })}</div><small>Changing source resets this demo. ${aiConfigured === null ? 'Checking AI setup…' : aiConfigured ? 'AI configured.' : 'AI needs a server key and Redis setup.'} No suppliers contacted.</small></section>`;
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
    : !state.recommendation || !state.recommendation.feasible ? 1 : !state.purchases.length ? 2 : state.order.status !== 'fulfilled' ? 3 : 4;
  const steps = ['Reserve stock', state.recommendation && !state.recommendation.feasible ? 'Review estimates' : 'Compare suppliers', 'Approve purchases', 'Receive & fulfill'];
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
    ${!order ? `<div class="workflow-budget-field"><label for="purchase-budget">Purchase budget · USD</label><input id="purchase-budget" type="number" min="0" max="1000000" step="0.01" value="${escape(budgetDraft)}" ${busy ? 'disabled' : ''}><small>Budget covers the combined purchased shortage. Set before creating the order.</small></div>` : ''}
    <div class="workflow-order-footer"><span>${icon('shield')}${state.other_order.reserved_quantity} units stay reserved for another order.</span>${!order ? button('create_order', `Create order ${icon('arrow')}`) : line.original_shortage === null ? button('reserve', `Reserve available stock ${icon('arrow')}`) : `<span class="workflow-small-note">Original shortage: ${shortage.original_shortage} units</span>`}</div>
  </section>`;
}

function supplierPanel(state: Snapshot): string {
  const plan = state.recommendation;
  const ai = state.source === 'ai';
  const approved = state.purchases.length > 0;
  const reserved = !!state.order && state.lines[0]?.original_shortage !== null;
  const hasPlan = !!plan?.feasible && plan.allocations.length > 0;
  const provenance = state.estimate_provenance;
  const selections = plan?.allocations.map(value => {
    const quote = state.quotes.find(q => q.id === value.quote_id);
    return `${value.quantity} from Supplier ${quote?.supplier_id ?? '—'}`;
  }).join(', ');
  return `<section class="panel workflow-suppliers" aria-labelledby="supplier-title">
    <div class="panel-heading"><div><div class="section-kicker">SOURCING THE SHORTAGE</div><h2 class="section-title" id="supplier-title">Cover the remaining shortage.</h2><p>${ai ? 'Unit prices and capacity are AI estimates, not supplier commitments.' : 'Neither supplier can cover the 11-unit shortage alone.'}</p></div><span class="workflow-source">${ai ? 'AI-generated estimates' : 'Synthetic estimates'}</span></div>
    <div class="workflow-supplier-grid">${state.suppliers.map(supplier => {
      const quote = state.quotes.find(value => value.supplier_id === supplier.id);
      const capacity = quote?.capacity_quantity ?? supplier.capacity_quantity;
      const priced = quote?.quantity_priced ?? supplier.quantity_priced;
      const price = quote?.price_cents ?? supplier.unit_price_cents;
      const delivery = quote?.expected_date ?? supplier.expected_date;
      const allocation = plan?.allocations.find(value => value.quote_id === quote?.id);
      const purchase = state.purchases.find(value => value.supplier_id === supplier.id);
      return `<article class="workflow-supplier ${allocation ? 'is-selected' : ''}">
        <div class="workflow-supplier-title"><span class="supplier-avatar">${escape(supplier.id)}</span><h3>${escape(supplier.name)}</h3>${allocation ? `<span class="workflow-selected">${icon('check')}Selected</span>` : ''}</div>
        <div class="workflow-price"><strong>${price === null ? '—' : money(price)}</strong><span>${price === null ? 'Not generated' : 'per unit · USD'}</span></div>
        <dl><div><dt>Capacity</dt><dd>${capacity === null ? '—' : `${capacity} units`}</dd></div><div><dt>Quantity priced</dt><dd>${priced === null ? '—' : `${priced} units`}</dd></div><div><dt>Delivery</dt><dd>${delivery ? dateLabel(delivery, true) : '—'}</dd></div></dl>
        <div class="workflow-supplier-allocation"><span>${purchase ? 'Purchased' : allocation ? 'Recommended' : plan ? 'Not selected' : 'Available to allocate'}</span><strong>${purchase || allocation ? `${purchase?.quantity ?? allocation?.quantity} units · ${money(purchase?.total_cents ?? allocation!.total_cents)}` : plan ? 'No purchase allocation' : capacity === null || price === null || priced === null ? 'Awaiting estimates' : `${Math.min(capacity, priced)} units · ${money(Math.min(capacity, priced) * price)}`}</strong></div>
      </article>`;
    }).join('')}</div>
    ${hasPlan ? `<div class="workflow-plan"><div>${icon('checkCircle')}<span><strong>${money(plan!.total_cents)} combined purchase</strong><small>${plan!.allocations.reduce((sum, value) => sum + value.quantity, 0)} units · Within the ${money(state.budget_cents)} purchase budget</small></span></div><span class="workflow-budget">${money(state.budget_cents - plan!.total_cents)} under budget</span></div>` : plan ? `<div class="workflow-no-plan"><strong>No purchase plan meets every constraint.</strong><p>Review the explanations below. Reset the demo to change the budget or source.</p></div>` : ''}
    ${provenance ? `<div class="workflow-provenance"><strong>Baseten · ${escape(provenance.model)}</strong><span>${provenance.cached ? 'Cached estimates reused · No fresh model call' : 'Fresh model generation'} · Generated ${escape(new Date(provenance.generatedAt).toLocaleString())} · Expires ${dateLabel(provenance.expiresAt.slice(0, 10), true)}</span></div>` : ''}
    ${plan ? `<details class="workflow-explanations" ${!hasPlan ? 'open' : ''}><summary>Rule checks${ai ? ' and estimate assumptions' : ''}</summary><ul>${[...plan.explanations, ...(state.assumptions ?? [])].map(value => `<li>${escape(value)}</li>`).join('')}</ul></details>` : ''}
    <div class="workflow-sourcing-action">${approved ? `<div class="workflow-approved">${icon('checkCircle')}<span><strong>${state.purchases.length} purchase${state.purchases.length === 1 ? '' : 's'} approved</strong><small>Company A demo owner · Approval left on-hand stock at 6</small></span></div>` : hasPlan ? `<div class="workflow-approval-copy"><strong>${escape(selections ?? '')}</strong><span>Creates ${plan!.allocations.length} purchase order(s) for ${money(plan!.total_cents)}. Approval does not add stock.</span><small>${ai ? 'Demo approval of hypothetical AI terms. No supplier order is sent.' : 'Approver: Company A demo owner'}</small></div>${button('approve', `Approve ${plan!.allocations.length === 2 ? 'both purchases' : 'purchases'} ${icon('check')}`)}` : plan ? '<p>No purchase can be approved from this result.</p>' : `<p>${busy && ai ? 'Generating estimates. This may take up to a minute.' : !reserved ? 'Reserve available stock before comparing the remaining shortage.' : ai ? 'One explicit request uses Baseten or its seven-day cache. No purchase is created.' : 'Compare quantity, delivery and combined cost. This creates no purchases.'}</p>${button(ai ? 'compare_ai' : 'compare', `${ai ? 'Generate AI estimates' : 'Compare suppliers'} ${icon('arrow')}`, { disabled: !reserved })}`}</div>
  </section>`;
}

function receivingPanel(state: Snapshot): string {
  if (!state.purchases.length) return '';
  const received = state.purchases.filter(value => value.status === 'received').length;
  const total = state.purchases.length;
  const ready = received === total;
  const fulfilled = state.order?.status === 'fulfilled';
  return `<section class="panel workflow-receiving" aria-labelledby="receiving-title">
    <div class="panel-heading"><div><div class="section-kicker">RECEIVING & FULFILLMENT</div><h2 class="section-title" id="receiving-title">${fulfilled ? 'Order fulfilled.' : ready ? 'All goods received.' : 'Receive each purchase.'}</h2><p>${fulfilled ? `${state.scenario.quantity} units consumed. The other order keeps its reservation.` : 'Each full demo receipt adds stock and reserves it for this customer.'}</p></div><span class="workflow-count">${received} / ${total} received</span></div>
    <div class="workflow-receipt-list">${state.purchases.map(purchase => `<div class="workflow-receipt"><span class="workflow-receipt-icon ${purchase.status === 'received' ? 'is-received' : ''}">${icon(purchase.status === 'received' ? 'check' : 'box')}</span><div><strong>Supplier ${escape(purchase.supplier_id)} · ${purchase.quantity} units</strong><small>${money(purchase.total_cents)} · ${purchase.status === 'received' ? 'Received in full' : 'Approved · Awaiting full receipt'}</small></div>${button(state.source === 'ai' ? 'receive' : purchase.supplier_id === 'X' ? 'receive_x' : 'receive_y', purchase.status === 'received' ? 'Received' : `Receive ${purchase.quantity} units`, { disabled: purchase.status === 'received', secondary: true, supplierId: purchase.supplier_id })}</div>`).join('')}</div>
    <div class="workflow-fulfillment ${fulfilled ? 'is-fulfilled' : ''}"><div><strong>${fulfilled ? 'Fulfillment complete' : ready ? `Ready to fulfill all ${state.scenario.quantity} units` : `Waiting for all ${state.scenario.quantity} units`}</strong><p>${fulfilled ? `Final stock: ${state.stock.on_hand} units, still reserved for the other order.` : ready ? 'Consume this order’s stock and release its reservations together.' : 'Try fulfillment now to see the incomplete order rejected.'}</p></div>${fulfilled ? `<span class="workflow-complete">${icon('checkCircle')}Fulfilled</span>` : button('fulfill', ready ? `Fulfill order ${icon('arrow')}` : 'Try fulfillment', { secondary: !ready })}</div>
  </section>`;
}

function sidebar(state: Snapshot): string {
  const fulfilled = state.order?.status === 'fulfilled';
  return `<aside class="workflow-sidebar">
    <section class="workflow-scenario"><div class="section-kicker">THE PREPARED SCENARIO</div><h2>15 ordered.<br> 4 available.</h2><p>Start with 6 units on hand. Another order already holds 2. ${state.source === 'ai' ? 'Ask Baseten for offers covering the remaining 11 units.' : 'Cover the remaining 11 with two suppliers.'}</p><dl><div><dt>Company</dt><dd>Company A</dd></div><div><dt>Stock location</dt><dd>One</dd></div><div><dt>Currency</dt><dd>USD</dd></div><div><dt>Purchase budget</dt><dd>${money(state.budget_cents)}</dd></div></dl><div class="workflow-scenario-note">${icon('info')}${state.source === 'ai' ? 'Stock is synthetic. Supplier terms are hypothetical AI estimates.' : 'Supplier quantities, prices and dates are synthetic.'}</div></section>
    <section class="panel workflow-checks"><div class="section-kicker">CHECK THE GUARANTEES</div><h2>Repeat it. Keep the stock.</h2><p>Completed receipts and fulfillment must not post twice.</p>${button('replay', 'Replay completed actions', { disabled: !fulfilled, secondary: true })}<p>Company B must be unable to use these Company A records.</p>${button('check_isolation', 'Check company isolation', { disabled: !state.order, secondary: true })}<small>Fixture company checks. Core authentication is not connected.</small></section>
    <section class="panel workflow-activity" aria-labelledby="activity-title"><div class="workflow-activity-heading"><h2 id="activity-title">Demo activity</h2><span>${state.events.length} actions</span></div>${state.events.length ? `<ol>${[...state.events].reverse().map((event) => `<li class="${event.ok ? '' : 'is-error'}"><span class="workflow-event-icon">${icon(event.ok ? 'check' : 'info')}</span><div><strong>${escape(event.label)}</strong><p>${escape(event.detail)}</p></div></li>`).join('')}</ol>` : '<p class="workflow-no-activity">Create the customer order to start.</p>'}</section>
  </aside>`;
}

function render(): void {
  app.setAttribute('aria-busy', String(busy));
  app.innerHTML = `${header()}<main class="page workflow-page">
    <section class="intro workflow-intro"><div><div class="eyebrow"><span class="eyebrow-line"></span>ORDER WORKFLOW</div><h1>From order<br><span>to fulfillment.</span></h1><p class="intro-copy">Reserve stock. Cover the shortage. Approve purchases.<br class="desktop-break"> Receive the goods, then fulfill the customer order.</p></div><div class="workflow-demo-note"><span class="demo-badge"><span></span>In-memory demo</span><p>${snapshot?.source === 'ai' ? 'AI-generated supplier estimates' : 'Synthetic supplier data'}<br> No suppliers contacted</p></div></section>
    ${snapshot ? `${sourcePanel(snapshot)}${metrics(snapshot)}${progress(snapshot)}` : ''}
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
  try {
    const [state, configured] = await Promise.all([getSnapshot(), estimateStatus().catch(() => false)]);
    snapshot = state; aiConfigured = configured; budgetDraft = (state.budget_cents / 100).toFixed(2);
  }
  catch (error) { failed = true; message = (error as Error).message; }
  finally { busy = false; render(); }
}

async function act(action: WorkflowAction, supplierId?: string): Promise<void> {
  if (busy) return;
  const data: { budget_cents?: number; supplier_id?: string } = {};
  try {
    if (action === 'create_order') data.budget_cents = parseMoney(budgetDraft);
    if (action === 'receive') data.supplier_id = supplierId;
  } catch (error) { failed = true; message = (error as Error).message; render(); return; }
  busy = true;
  message = '';
  render();
  try {
    const result = await sendAction(action, undefined, data);
    snapshot = result.snapshot;
    if (['reset', 'use_ai', 'use_sample'].includes(action)) budgetDraft = (snapshot.budget_cents / 100).toFixed(2);
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
  if (action) void act(action as WorkflowAction, target.dataset.supplier);
});

app.addEventListener('input', event => {
  if ((event.target as HTMLInputElement).id === 'purchase-budget') budgetDraft = (event.target as HTMLInputElement).value;
});

void load();
