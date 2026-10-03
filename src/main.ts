import '@fontsource-variable/dm-sans';
import './styles.css';
import { mockQuotes, requestFromDraft, sampleDraft, scenarioForItem, scenarios, suppliers } from './data';
import { compareQuotes } from './domain/compare';
import { dateLabel, deliveryGapDays, evaluationReason, money } from './domain/reasons';
import type { ComparisonResult, DraftErrors, Evaluation, ProcurementRequest, PurchasingPreference, RequestDraft, SupplierQuote } from './domain/model';
import { validateDraft } from './domain/validate';
import { brandMark, icon } from './icons';
import { EstimateError, estimateStatus, generateEstimates, type EstimateProvenance } from './estimates-client';

type Step = 1 | 2 | 3;
let step: Step = 1;
let activeScenario = scenarios[0];
let draft = sampleDraft();
let request: ProcurementRequest | null = null;
let quotes: SupplierQuote[] = [];
let result: ComparisonResult | null = null;
let preference: PurchasingPreference = 'lowest_cost';
let quoteSource: 'ai' | 'sample' = 'ai';
let connection: 'checking' | 'ready' | 'unavailable' = 'checking';
let generating = false;
let generationError = '';
let needsClarification = false;
let provenance: EstimateProvenance | null = null;
let assumptions: string[] = [];
let generationRevision = 0;
let statusRevision = 0;
let generationController: AbortController | null = null;
let toastTimer: ReturnType<typeof setTimeout>;

const app = document.querySelector<HTMLDivElement>('#app')!;

function escape(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function supplierName(id: string): string {
  return suppliers.find((supplier) => supplier.id === id)?.name ?? id;
}

app.innerHTML = `
  <header class="header">
    <a class="brand" href="/" aria-label="LogisticsNerd home">${brandMark}<span>logistics<span class="brand-light">nerd</span><span class="brand-dot">.</span></span></a>
    <div class="header-center"><span class="header-divider"></span>Small business. Better buying.</div>
    <div class="header-actions"><span class="demo-badge"><span></span>Interactive demo</span><button type="button" class="reset-button" id="reset">${icon('reset')}<span>Start again</span></button></div>
  </header>
  <main class="page">
    <section class="intro" aria-labelledby="page-title">
      <div><div class="eyebrow"><span class="eyebrow-line"></span>PROCUREMENT, SIMPLIFIED</div><h1 id="page-title">The right supplier.<br><span>A clearer decision.</span></h1><p class="intro-copy">Compare price and delivery for the quantity you need.<br class="desktop-break"> Choose your priority. See exactly why it wins.</p></div>
      <div class="intro-note"><div class="note-symbol">${icon('shield')}</div><div><strong>Clear rules. Confident choices.</strong><p>Every recommendation comes<br>with a reason you can inspect.</p></div></div>
    </section>
    <nav class="steps" aria-label="Procurement progress" id="steps"></nav>
    <div class="workspace" id="workspace"></div>
    <footer class="footer"><span>${icon('box')} A small step toward a better buy.</span><span id="source-footer">AI-generated estimates · USD · No suppliers contacted</span></footer>
  </main>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
`;

const workspace = document.querySelector<HTMLDivElement>('#workspace')!;

function showToast(message: string): void {
  const toast = document.querySelector<HTMLDivElement>('#toast')!;
  clearTimeout(toastTimer);
  toast.innerHTML = `${icon('checkCircle')}<span>${escape(message)}</span>`;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

function progress(): void {
  document.querySelector('#steps')!.innerHTML = [
    { number: 1, title: 'Your request', detail: 'Define what you need' },
    { number: 2, title: 'Supplier quotes', detail: 'Review the offers' },
    { number: 3, title: 'Your decision', detail: 'Find the best fit' },
  ].map((value) => `<div class="step ${step === value.number ? 'active' : ''} ${step > value.number ? 'complete' : ''}" ${step === value.number ? 'aria-current="step"' : ''}><span class="step-number">${step > value.number ? icon('check') : `0${value.number}`}</span><span><strong>${value.title}</strong><small>${value.detail}</small></span>${value.number < 3 ? '<span class="step-connector"></span>' : ''}</div>`).join('');
}

function render(focus = false): void {
  progress();
  document.querySelector('#source-footer')!.textContent = `${quoteSource === 'ai' ? 'AI-generated estimates' : 'Fictional sample quotes'} · USD · No suppliers contacted`;
  workspace.innerHTML = step === 1 ? requestView() : step === 2 ? quotesView() : resultsView();
  bindStep();
  if (focus) {
    const heading = workspace.querySelector<HTMLElement>('.section-title');
    heading?.focus({ preventScroll: true });
    document.querySelector('#steps')!.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }
}

function fieldError(field: string): string {
  return `<span class="field-error" id="error-${field}" aria-live="polite"></span>`;
}

function scenarioPicker(): string {
  return `<section class="scenario-section" aria-label="Sample scenarios"><div class="scenario-heading"><span class="section-kicker">${quoteSource === 'ai' ? 'CHOOSE A STARTING POINT' : 'CHOOSE A SAMPLE SCENARIO'}</span><span>${quoteSource === 'ai' ? 'Edit the item and quantity to make it yours' : 'Fictional quotes, real decision rules'}</span></div><div class="scenario-options" role="group" aria-label="Choose a sample scenario">${scenarios.map((scenario, index) => `<button class="scenario-option ${activeScenario.id === scenario.id ? 'is-active' : ''}" type="button" data-scenario="${scenario.id}" aria-pressed="${activeScenario.id === scenario.id}"><span class="scenario-top"><span class="scenario-icon">${icon(index === 0 ? 'chair' : index === 1 ? 'paper' : 'box')}</span><span class="scenario-check">${icon('check')}</span></span><strong>${escape(scenario.title)}</strong><small>${scenario.quantity} ${scenario.unitLabel} · ${scenario.suppliers.length} suppliers</small></button>`).join('')}</div><p class="scenario-lesson">${icon('spark')}<span>${quoteSource === 'ai' ? 'These are illustrative supplier identities. Generated offers are estimates, not supplier quotes.' : escape(activeScenario.lesson)}</span></p></section>`;
}

function sourcePicker(): string {
  return `<section class="source-section" aria-label="Quote source"><div class="source-heading"><span class="section-kicker">YOUR QUOTE SOURCE</span><span class="source-connection ${connection === 'ready' ? 'is-ready' : ''}"><span></span>${connection === 'checking' ? 'Checking AI connection' : connection === 'ready' ? 'AI ready' : 'AI unavailable'}</span></div><div class="source-options" role="group" aria-label="Choose quote source"><button class="source-option ${quoteSource === 'ai' ? 'is-active' : ''}" type="button" data-source="ai" aria-pressed="${quoteSource === 'ai'}">${icon('spark')}<span><strong>AI estimates</strong><small>Custom items and quantities</small></span>${icon('check')}</button><button class="source-option ${quoteSource === 'sample' ? 'is-active' : ''}" type="button" data-source="sample" aria-pressed="${quoteSource === 'sample'}">${icon('list')}<span><strong>Use sample data</strong><small>Explore the prepared examples</small></span>${icon('check')}</button></div><p class="source-help">${quoteSource === 'sample' ? 'Prepared fictional quotes. No model request is made.' : connection === 'unavailable' ? 'AI estimates are unavailable. Check the connection or choose sample data to continue.' : 'Hypothetical prices, stock, and delivery dates. USD · Standard-quality goods · Domestic US delivery. No suppliers contacted.'}</p>${connection === 'unavailable' ? '<button class="text-button connection-retry" id="check-connection" type="button">Check connection</button>' : ''}</section>`;
}

function generationFeedback(): string {
  return `<div class="generation-feedback ${generating ? 'is-loading' : generationError ? 'has-error' : ''}" id="generation-feedback" aria-live="polite" ${!generating && !generationError ? 'hidden' : ''}>${generating ? '<span class="loading-spinner" aria-hidden="true"></span><div><strong>Building your estimates.</strong><span>Comparing 3–5 hypothetical offers. You can keep editing.</span></div><button class="text-button" id="cancel-generation" type="button">Cancel</button>' : generationError ? `${icon('info')}<div><strong>${needsClarification ? 'A little more detail, please.' : 'Let’s try that again.'}</strong><span>${escape(generationError)}</span></div>` : ''}</div>`;
}

function assumptionView(): string {
  if (!provenance) return '';
  return `<details class="estimate-assumptions"><summary>${icon('info')}Assumptions behind these estimates</summary>${assumptions.length ? `<ul>${assumptions.map((value) => `<li>${escape(value)}</li>`).join('')}</ul>` : '<p>Standard-quality goods and domestic US delivery are assumed.</p>'}<p class="estimate-provenance">Generated ${escape(new Date(provenance.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} · ${escape(provenance.model)}${provenance.cached ? ' · Reused estimate' : ''}</p></details>`;
}

function preferenceLabel(): string {
  return preference === 'lowest_cost' ? 'Lowest cost' : 'Earliest delivery';
}

function preferencePicker(): string {
  return `<section class="preference-section" aria-label="Purchasing preference"><div class="preference-heading"><strong>What matters most?</strong><span>Both choices must meet your requirements.</span></div><div class="preference-options" role="group" aria-label="Choose purchasing preference"><button type="button" class="preference-option ${preference === 'lowest_cost' ? 'is-active' : ''}" data-preference="lowest_cost" aria-pressed="${preference === 'lowest_cost'}">${icon('money')}<span><strong>Lowest cost</strong><small>Save on the full order</small></span><span class="preference-check">${icon('check')}</span></button><button type="button" class="preference-option ${preference === 'earliest_delivery' ? 'is-active' : ''}" data-preference="earliest_delivery" aria-pressed="${preference === 'earliest_delivery'}">${icon('clock')}<span><strong>Earliest delivery</strong><small>Get what you need sooner</small></span><span class="preference-check">${icon('check')}</span></button></div><p class="preference-rule">${preference === 'lowest_cost' ? 'Lowest total first. Earlier delivery breaks a price tie.' : 'Earliest delivery first. Lower total breaks a delivery tie.'}</p></section>`;
}

function requestView(): string {
  return `
    <section class="panel form-panel enter">
      <div class="panel-heading"><div><div class="section-kicker">LET'S START WITH THE ESSENTIALS</div><h2 class="section-title" tabindex="-1">What do you need?</h2><p>One item. A few suppliers. A decision that makes sense.</p></div><span class="section-symbol">${icon('box')}</span></div>
      ${sourcePicker()}
      ${scenarioPicker()}
      <form id="request-form" novalidate aria-busy="${generating}">
        <div class="form-fields">
          <div class="field"><label for="item">Item name</label><div class="input-wrap">${icon('box')}<input id="item" name="item" type="text" maxlength="160" value="${escape(draft.item)}" placeholder="e.g. Office chairs" required aria-describedby="error-item" /></div>${fieldError('item')}</div>
          <div class="field-grid"><div class="field"><label for="quantity">Quantity</label><div class="input-wrap"><input id="quantity" name="quantity" type="number" min="1" step="1" value="${escape(draft.quantity)}" required aria-describedby="error-quantity" /><span class="input-suffix" id="quantity-unit">${scenarioForItem(draft.item)?.unitLabel ?? 'units'}</span></div>${fieldError('quantity')}</div><div class="field"><label for="deadline">Required by</label><div class="input-wrap">${icon('calendar')}<input id="deadline" name="deadline" type="date" value="${escape(draft.deadline)}" required aria-describedby="error-deadline" /></div>${fieldError('deadline')}</div></div>
          <div class="field budget-field"><label for="budget">Maximum budget <span class="optional">Optional</span></label><div class="input-wrap"><span class="currency-prefix">$</span><input id="budget" name="budget" type="number" min="0" step="0.01" value="${escape(draft.budget)}" placeholder="No budget limit" aria-describedby="budget-help error-budget" /><span class="input-suffix">USD</span></div><span class="field-help" id="budget-help">Leave blank to compare without a budget limit.</span>${fieldError('budget')}</div>
        </div>
        ${preferencePicker()}
        <fieldset class="supplier-section" aria-describedby="error-suppliers"><legend>Choose your suppliers <span class="supplier-count" id="supplier-count">${draft.supplierIds.length} selected</span></legend><p>${activeScenario.suppliers.length} illustrative suppliers for this ${quoteSource === 'ai' ? 'starting point' : 'scenario'}. Select 3–5 to compare.</p><div class="supplier-options">${activeScenario.suppliers.map((supplier, index) => `<label class="supplier-option ${draft.supplierIds.includes(supplier.id) ? 'selected' : ''}"><input type="checkbox" name="supplier" value="${supplier.id}" ${draft.supplierIds.includes(supplier.id) ? 'checked' : ''} /><span class="supplier-avatar avatar-${index}">${supplier.initials}</span><span class="supplier-option-name">${escape(supplier.name)}</span><span class="custom-checkbox">${icon('check')}</span></label>`).join('')}</div>${fieldError('suppliers')}</fieldset>
        ${generationFeedback()}
        <div class="form-bottom"><button class="text-button" id="sample" type="button">${icon('spark')}Restore example</button><button class="button button-primary" id="submit-request" type="submit" ${generating || quoteSource === 'ai' && connection !== 'ready' ? 'disabled' : ''}>${generating ? '<span class="loading-spinner" aria-hidden="true"></span>Generating estimates' : quoteSource === 'ai' ? `Generate supplier estimates ${icon('arrow')}` : `Review supplier quotes ${icon('arrow')}`}</button></div>
      </form>
    </section>
    <aside class="aside enter" style="--delay: 70ms">
      <section class="guide-panel"><div class="guide-top"><span class="guide-label">A BETTER WAY TO COMPARE</span><span class="guide-orbit">${icon('spark')}</span></div><h2>Price matters.<br>${quoteSource === 'ai' ? 'So does the timing.' : 'So does the promise.'}</h2><p class="guide-copy">A low price only helps if the supplier can meet your needs.</p><div class="guide-rules"><div><span class="guide-rule-icon">${icon('box')}</span><span><strong>The right quantity</strong><small>Enough to fulfill your request.</small></span><span class="rule-index">01</span></div><div><span class="guide-rule-icon">${icon('calendar')}</span><span><strong>On time</strong><small>Delivered by your deadline.</small></span><span class="rule-index">02</span></div><div><span class="guide-rule-icon">${icon('money')}</span><span><strong>${preference === 'lowest_cost' ? 'The lowest feasible price' : 'The earliest feasible delivery'}</strong><small>Within your budget, if you set one.</small></span><span class="rule-index">03</span></div></div><div class="guide-bottom"><span class="tiny-dot"></span>${quoteSource === 'ai' ? 'Estimated offers. Exact decision rules.' : 'Simple rules. No guesswork.'}</div></section>
      <section class="sample-note"><span class="sample-note-icon">${icon('info')}</span><div><strong>${quoteSource === 'ai' ? 'A flexible, illustrative comparison' : `${escape(activeScenario.title)} example`}</strong><p>${quoteSource === 'ai' ? 'Describe an ordinary good and the quantity you need. Your inputs are sent to Baseten to create hypothetical offers; the app checks the rules and selects the best fit. These estimates do not verify supplier prices or stock.' : `${escape(activeScenario.description)}. Quotes cover ${activeScenario.quantity} ${activeScenario.unitLabel}; edit the deadline or budget to explore. Nothing is sent externally.`}</p></div></section>
    </aside>`;
}

function requestSummary(): string {
  if (!request) return '';
  const item = request.items[0];
  return `<section class="summary-panel"><div class="summary-heading"><span class="section-kicker">YOUR REQUEST</span><button class="icon-button" type="button" data-edit aria-label="Edit your request">${icon('edit')}</button></div><h3>${escape(item.name)}</h3><dl><div><dt>Quantity</dt><dd>${item.quantity} ${item.unitLabel ?? 'units'}</dd></div><div><dt>Required by</dt><dd>${dateLabel(item.requiredDate, true)}</dd></div><div><dt>Budget</dt><dd>${request.maxBudgetCents === null ? 'No limit set' : money(request.maxBudgetCents)}</dd></div><div><dt>Suppliers</dt><dd>${request.selectedSupplierIds.length} selected</dd></div><div><dt>Priority</dt><dd>${preferenceLabel()}</dd></div></dl></section>`;
}

function quoteCard(quote: SupplierQuote, index: number): string {
  const supplier = suppliers.find((value) => value.id === quote.supplierId)!;
  const line = quote.items[0];
  const total = line.price.kind === 'unit' ? line.price.cents * request!.items[0].quantity : line.price.cents;
  return `<article class="quote-card" style="--delay: ${index * 55}ms"><div class="quote-card-top"><span class="supplier-avatar avatar-${index}">${supplier.initials}</span><div><h3>${escape(supplier.name)}</h3><span class="quote-reference">${quoteSource === 'ai' ? 'ESTIMATE' : 'QUOTE'} 0${index + 1}</span></div><span class="response-status"><span></span>${quoteSource === 'ai' ? 'AI estimate' : 'Sample'}</span></div><div class="quote-card-body"><div><span class="metric-label">${quoteSource === 'ai' ? 'ESTIMATED' : 'QUOTED'} TOTAL</span><strong class="quote-price">${money(total)}</strong></div><div class="quote-facts"><span>${icon('box')}<span><strong>${line.availableQuantity} ${escape(request!.items[0].unitLabel ?? 'units')}</strong><small>${quoteSource === 'ai' ? 'Estimated availability' : 'Available quantity'}</small></span></span><span>${icon('calendar')}<span><strong>${dateLabel(line.expectedDate, true)}</strong><small>${quoteSource === 'ai' ? 'Estimated delivery' : 'Expected delivery'}</small></span></span></div></div>${quote.notes ? `<p class="quote-note">${escape(quote.notes)}</p>` : ''}</article>`;
}

function quotesView(): string {
  return `<section class="panel quotes-panel enter"><div class="panel-heading"><div><div class="section-kicker">${quoteSource === 'ai' ? 'YOUR ESTIMATES ARE READY' : 'THE OFFERS ARE IN'}</div><h2 class="section-title" tabindex="-1">${quoteSource === 'ai' ? 'Your estimates, side by side.' : 'A closer look at your quotes.'}</h2><p>Compare ${quoteSource === 'ai' ? 'the estimated offers' : 'the facts'} before making the call.</p></div><span class="section-symbol">${icon('list')}</span></div><div class="inline-notice estimate-disclosure">${icon('info')}<span>${quoteSource === 'ai' ? 'AI-generated estimates · Hypothetical prices, stock, and delivery dates.' : `Fictional sample quotes · ${activeScenario.quantity} ${activeScenario.unitLabel} · ${escape(activeScenario.description)}.`} No suppliers contacted.</span></div>${quotes.length ? `<div class="quote-list">${quotes.map(quoteCard).join('')}</div><p class="quote-convention">${quoteSource === 'ai' ? 'Estimated' : 'Quoted'} totals are in USD and assumed to include all charges.</p>${assumptionView()}<div class="panel-actions"><button type="button" class="text-button" data-edit>${icon('back')}Edit request</button><button class="button button-primary" id="compare" type="button">Find the best supplier ${icon('arrow')}</button></div>` : `<div class="empty-state"><span class="empty-icon">${icon('box')}</span><h3>No demo quotes for this request.</h3><p>This example has quotes for ${activeScenario.quantity} ${activeScenario.unitLabel} (${escape(activeScenario.itemName)}). Restore it below, or edit your request and choose another scenario. Sample prices are never reused for a different item or quantity.</p><button class="button button-primary" id="restore-sample" type="button">Restore ${escape(activeScenario.title.toLowerCase())} example ${icon('arrow')}</button><button class="text-button" data-edit type="button">${icon('back')}Edit your request</button></div>`}</section><aside class="aside enter" style="--delay: 70ms">${requestSummary()}<section class="quiet-note">${icon('shield')}<h3>Clear rules. A consistent decision.</h3><p>We'll check quantity, delivery, and your optional budget, then compare the ${quoteSource === 'ai' ? 'estimates' : 'quotes'} that qualify.</p><span class="note-rule">${preference === 'lowest_cost' ? 'Lowest price → earlier delivery if tied' : 'Earliest delivery → lower price if tied'}</span></section></aside>`;
}

function evaluationRow(value: Evaluation, index: number): string {
  if (!request || !result) return '';
  const supplier = suppliers.find((item) => item.id === value.supplierId)!;
  const recommended = result.recommendedSupplierIds.includes(value.supplierId);
  const item = request.items[0];
  const reason = evaluationReason(value, result, request);
  const explanation = quoteSource === 'ai' ? reason.replaceAll('quote', 'estimate').replace('promises earlier delivery', 'has an earlier estimated delivery') : reason;
  const status = recommended ? result.outcome === 'tied' ? 'Tied best' : 'Recommended' : value.feasible ? 'Feasible' : 'Not feasible';
  const quantityPass = value.availableQuantity >= item.quantity;
  const datePass = value.expectedDate <= item.requiredDate;
  return `<article class="evaluation-row ${recommended ? 'is-recommended' : ''} ${!value.feasible ? 'is-rejected' : ''}" style="--delay:${index * 45}ms"><div class="evaluation-top"><div class="supplier-identity"><span class="supplier-avatar avatar-${index}">${supplier.initials}</span><div><h3>${escape(supplier.name)}</h3><span class="status-pill ${recommended ? 'recommended' : value.feasible ? 'feasible' : 'rejected'}">${icon(recommended ? 'checkCircle' : value.feasible ? 'check' : 'minus')}${status}</span></div></div><strong class="evaluation-price">${money(value.totalCents)}</strong></div><div class="evaluation-facts"><span class="fact ${quantityPass ? '' : 'failed'}">${icon(quantityPass ? 'check' : 'x')}${value.availableQuantity} of ${item.quantity} ${item.unitLabel ?? 'units'}</span><span class="fact ${datePass ? '' : 'failed'}">${icon(datePass ? 'check' : 'x')}Delivery ${dateLabel(value.expectedDate, true)}</span>${request.maxBudgetCents !== null ? `<span class="fact ${value.totalCents <= request.maxBudgetCents ? '' : 'failed'}">${icon(value.totalCents <= request.maxBudgetCents ? 'check' : 'x')}${value.totalCents <= request.maxBudgetCents ? 'Within budget' : 'Over budget'}</span>` : ''}</div><p class="evaluation-reason">${escape(explanation)}</p></article>`;
}

function decisionAside(): string {
  if (!request || !result) return '';
  const best = result.feasible[0];
  if (!best) return `${requestSummary()}<section class="quiet-note">${icon('info')}<h3>Review the constraints.</h3><p>You can adjust the deadline or budget, review the quantity, or request quotes from other suppliers.</p><button class="text-button" data-edit type="button">Edit request ${icon('arrow')}</button></section>`;
  const item = request.items[0];
  return `<section class="decision-panel"><div class="guide-top"><span class="guide-label">WHY THIS ${result.outcome === 'tied' ? 'PRICE' : 'QUOTE'} WORKS</span>${icon('shield')}</div><h3>Every requirement. <br>Accounted for.</h3><div class="decision-check"><span>${icon('check')}</span><div><strong>Quantity met</strong><small>${best.availableQuantity} available · ${item.quantity} required</small></div></div><div class="decision-check"><span>${icon('check')}</span><div><strong>Deadline met</strong><small>${dateLabel(best.expectedDate, true)} delivery · ${dateLabel(item.requiredDate, true)} deadline</small></div></div>${request.maxBudgetCents !== null ? `<div class="decision-check"><span>${icon('check')}</span><div><strong>Within your budget</strong><small>${money(best.totalCents)} total · ${money(request.maxBudgetCents)} limit</small></div></div>` : ''}<div class="decision-bottom">${icon('checkCircle')}${preference === 'lowest_cost' ? 'Lowest total among feasible quotes' : 'Earliest delivery among feasible quotes'}</div></section>${requestSummary()}`;
}

function decisionTradeoff(): string {
  if (!result?.feasible.length) return '';
  const cheapest = [...result.feasible].sort((a, b) => a.totalCents - b.totalCents || a.expectedDate.localeCompare(b.expectedDate))[0];
  const earliest = [...result.feasible].sort((a, b) => a.expectedDate.localeCompare(b.expectedDate) || a.totalCents - b.totalCents)[0];
  const days = deliveryGapDays(earliest.expectedDate, cheapest.expectedDate);
  if (!days) return `<div class="tradeoff-note">${icon('checkCircle')}<p>The best ${quoteSource === 'ai' ? 'estimate' : 'quote'} has both the lowest total and the earliest feasible delivery.</p></div>`;
  return `<div class="tradeoff-note">${icon('clock')}<p><strong>${escape(supplierName(earliest.supplierId))}</strong> ${quoteSource === 'ai' ? 'has an estimated delivery' : 'promises delivery'} <strong>${days} ${days === 1 ? 'day' : 'days'} earlier</strong> for <strong>${money(earliest.totalCents - cheapest.totalCents)} more</strong> than ${escape(supplierName(cheapest.supplierId))}.</p></div>`;
}

function resultsView(): string {
  if (!request || !result) return '';
  const best = result.feasible[0];
  const alternative = result.feasible.find((value) => !result!.recommendedSupplierIds.includes(value.supplierId));
  const savings = best && alternative ? alternative.totalCents - best.totalCents : 0;
  const hasWinner = !!best;
  const tied = result.outcome === 'tied';
  const earliest = preference === 'earliest_delivery';
  let banner: string;
  if (best) {
    banner = `<div class="winner-banner"><div class="winner-label">${icon('checkCircle')} ${tied ? 'TIED BEST FEASIBLE QUOTES' : earliest ? 'EARLIEST FEASIBLE DELIVERY' : 'LOWEST FEASIBLE TOTAL'}</div><div class="winner-main"><div><h3>${escape(tied ? result.recommendedSupplierIds.map(supplierName).join(' & ') : supplierName(best.supplierId))}</h3><p>${tied ? 'Same price and delivery date. Choose either for the full order.' : `${request.items[0].quantity} ${request.items[0].unitLabel ?? 'units'} · Delivery ${dateLabel(best.expectedDate, true)}`}</p></div><div class="winner-cost"><strong>${money(best.totalCents)}</strong><span>${quoteSource === 'ai' ? 'estimated total' : 'quoted total'}</span></div></div>${!earliest && savings > 0 ? `<div class="winner-saving">${icon('spark')} ${money(savings)} less than the next feasible quote</div>` : '<div class="winner-saving">'+icon('check')+(earliest ? ' The earliest delivery that meets your requirements</div>' : ' The lowest price that meets your requirements</div>')}</div>`;
  } else {
    banner = `<div class="no-winner-banner"><span class="empty-icon">${icon('info')}</span><div><h3>No quote meets every requirement.</h3><p>Review the reasons below, then adjust your request or supplier set.</p></div></div>`;
  }
  return `<section class="panel results-panel enter"><div class="panel-heading"><div><div class="section-kicker">THE COMPARISON, MADE CLEAR</div><h2 class="section-title" tabindex="-1">${hasWinner ? tied ? 'Equally good fits.' : 'A clear choice.' : 'Let’s find another fit.'}</h2><p>${hasWinner ? earliest ? 'The earliest delivery among the quotes that meet your needs.' : 'The best price among the quotes that meet your needs.' : 'The constraints matter as much as the price.'}</p></div><span class="section-symbol">${icon(hasWinner ? 'checkCircle' : 'info')}</span></div>${quoteSource === 'ai' ? `<div class="inline-notice estimate-disclosure">${icon('info')}<span>AI-generated estimates · No suppliers contacted. This compares hypothetical offers.</span></div>` : ''}${preferencePicker()}${banner}${hasWinner ? decisionTradeoff() : ''}<div class="comparison-heading"><h3>Every ${quoteSource === 'ai' ? 'estimate' : 'quote'}, explained</h3><span>${result.feasible.length} of ${result.evaluations.length} feasible</span></div><div class="evaluation-list">${result.evaluations.map(evaluationRow).join('')}</div>${assumptionView()}<div class="result-disclosure">${icon('info')}${quoteSource === 'ai' ? 'Based on AI-generated estimates. Prices, stock, and delivery dates are unverified.' : 'Based on fictional supplier promises.'} This is a recommendation, not an order.</div><div class="panel-actions"><button class="text-button" type="button" id="back-quotes">${icon('back')}Review ${quoteSource === 'ai' ? 'estimates' : 'quotes'}</button><button class="button button-secondary" type="button" data-edit>${icon('edit')}Adjust your request</button></div></section><aside class="aside enter" style="--delay: 70ms">${decisionAside()}</aside>`;
}

function readDraft(form: HTMLFormElement): RequestDraft {
  const data = new FormData(form);
  return {
    item: String(data.get('item') ?? ''), quantity: String(data.get('quantity') ?? ''),
    deadline: String(data.get('deadline') ?? ''), budget: String(data.get('budget') ?? ''),
    supplierIds: data.getAll('supplier').map(String),
  };
}

function showErrors(errors: DraftErrors): void {
  for (const field of ['item', 'quantity', 'deadline', 'budget', 'suppliers'] as const) {
    const element = document.querySelector<HTMLInputElement>(`#${field}`);
    const target = document.querySelector(`#error-${field}`);
    if (target) target.textContent = errors[field] ?? '';
    element?.setAttribute('aria-invalid', String(!!errors[field]));
    element?.closest('.field')?.classList.toggle('invalid', !!errors[field]);
  }
}

function editRequest(): void {
  invalidateGeneration();
  step = 1;
  request = null;
  quotes = [];
  result = null;
  provenance = null;
  assumptions = [];
  render(true);
}

function loadExample(goToQuotes = false, scenarioId = activeScenario.id, focusPicker = false): void {
  invalidateGeneration();
  activeScenario = scenarios.find((scenario) => scenario.id === scenarioId)!;
  draft = sampleDraft(activeScenario.id);
  request = null;
  quotes = [];
  result = null;
  provenance = null;
  assumptions = [];
  step = 1;
  if (goToQuotes) {
    request = requestFromDraft(draft);
    quotes = mockQuotes(request);
    step = 2;
  }
  render(goToQuotes);
  if (focusPicker) workspace.querySelector<HTMLButtonElement>(`[data-scenario="${activeScenario.id}"]`)?.focus({ preventScroll: true });
  showToast(`${activeScenario.title} example loaded. You’re ready to compare.`);
}

function invalidateGeneration(): void {
  generationRevision += 1;
  generationController?.abort();
  generationController = null;
  generating = false;
  generationError = '';
  needsClarification = false;
}

function bindCancel(): void {
  document.querySelector('#cancel-generation')?.addEventListener('click', () => {
    invalidateGeneration();
    updateGenerationFeedback();
    showToast('Estimate request cancelled. Your inputs are saved.');
  });
}

function updateGenerationFeedback(): void {
  const feedback = workspace.querySelector('#generation-feedback');
  if (feedback) feedback.outerHTML = generationFeedback();
  const button = workspace.querySelector<HTMLButtonElement>('#submit-request');
  if (button) {
    button.disabled = generating || quoteSource === 'ai' && connection !== 'ready';
    button.innerHTML = generating ? '<span class="loading-spinner" aria-hidden="true"></span>Generating estimates'
      : `${quoteSource === 'ai' ? 'Generate supplier estimates' : 'Review supplier quotes'} ${icon('arrow')}`;
  }
  workspace.querySelector('#request-form')?.setAttribute('aria-busy', String(generating));
  bindCancel();
}

function renderConnectionUpdate(): void {
  const focused = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
  const focusId = focused?.id;
  const supplierId = focused?.name === 'supplier' ? focused.value : null;
  const selection = focused?.type === 'text' ? [focused.selectionStart, focused.selectionEnd] : null;
  draft = readDraft(workspace.querySelector<HTMLFormElement>('#request-form')!);
  render();
  const target = focusId ? document.getElementById(focusId) as HTMLInputElement | null
    : supplierId ? workspace.querySelector<HTMLInputElement>(`input[name="supplier"][value="${supplierId}"]`) : null;
  target?.focus({ preventScroll: true });
  if (selection && target) target.setSelectionRange(selection[0], selection[1]);
}

async function refreshConnection(): Promise<void> {
  const revision = ++statusRevision;
  connection = 'checking';
  if (step === 1) renderConnectionUpdate();
  try {
    const configured = await estimateStatus();
    if (revision !== statusRevision) return;
    connection = configured ? 'ready' : 'unavailable';
  } catch {
    if (revision !== statusRevision) return;
    connection = 'unavailable';
  }
  if (step === 1) renderConnectionUpdate();
}

async function submitRequest(form: HTMLFormElement): Promise<void> {
  if (generating) return;
  draft = readDraft(form);
  const errors = validateDraft(draft);
  showErrors(errors);
  if (Object.keys(errors).length) {
    const first = Object.keys(errors)[0];
    const element = first === 'suppliers' ? form.querySelector<HTMLInputElement>('input[name="supplier"]') : form.querySelector<HTMLInputElement>(`#${first}`);
    element?.focus();
    return;
  }
  const submittedRequest = requestFromDraft(draft);
  if (quoteSource === 'sample') {
    request = submittedRequest;
    quotes = mockQuotes(request);
    result = null;
    step = 2;
    render(true);
    return;
  }
  if (connection !== 'ready') return;
  invalidateGeneration();
  const revision = generationRevision;
  const controller = new AbortController();
  generationController = controller;
  generating = true;
  updateGenerationFeedback();
  try {
    const response = await generateEstimates(submittedRequest,
      submittedRequest.selectedSupplierIds.map((id) => ({ id, name: supplierName(id) })), preference, controller.signal);
    if (revision !== generationRevision || controller.signal.aborted) return;
    request = submittedRequest;
    quotes = response.quotes;
    provenance = response.provenance;
    assumptions = response.assumptions;
    result = null;
    generating = false;
    generationController = null;
    step = 2;
    render(true);
    showToast(response.provenance.cached ? 'Your saved estimates are ready.' : 'Estimates ready. No suppliers were contacted.');
  } catch (error) {
    if (revision !== generationRevision || controller.signal.aborted) return;
    generating = false;
    generationController = null;
    generationError = error instanceof Error ? error.message : 'We could not generate estimates. Please try again.';
    needsClarification = error instanceof EstimateError && error.code === 'needs_clarification';
    updateGenerationFeedback();
    workspace.querySelector<HTMLElement>('#generation-feedback')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function bindStep(): void {
  workspace.querySelectorAll<HTMLButtonElement>('[data-preference]').forEach((button) => button.addEventListener('click', () => {
    const next = button.dataset.preference as PurchasingPreference;
    if (next === preference) return;
    if (step === 1) draft = readDraft(document.querySelector<HTMLFormElement>('#request-form')!);
    preference = next;
    if (step === 3) result = compareQuotes(request!, quotes, preference);
    render();
    workspace.querySelector<HTMLButtonElement>(`[data-preference="${preference}"]`)?.focus({ preventScroll: true });
    showToast(`${preferenceLabel()} selected.${step === 3 ? ' Recommendation updated.' : ''}`);
  }));
  workspace.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((button) => button.addEventListener('click', editRequest));
  if (step === 1) {
    workspace.querySelectorAll<HTMLButtonElement>('[data-source]').forEach((button) => button.addEventListener('click', () => {
      const next = button.dataset.source as 'ai' | 'sample';
      if (next === quoteSource) return;
      draft = readDraft(workspace.querySelector<HTMLFormElement>('#request-form')!);
      invalidateGeneration();
      quoteSource = next;
      provenance = null;
      assumptions = [];
      render();
      workspace.querySelector<HTMLButtonElement>(`[data-source="${quoteSource}"]`)?.focus({ preventScroll: true });
    }));
    workspace.querySelector('#check-connection')?.addEventListener('click', () => { void refreshConnection(); });
    bindCancel();
    workspace.querySelectorAll<HTMLButtonElement>('[data-scenario]').forEach((button) => button.addEventListener('click', () => loadExample(false, button.dataset.scenario!, true)));
    const form = document.querySelector<HTMLFormElement>('#request-form')!;
    form.addEventListener('input', (event) => {
      draft = readDraft(form);
      if (generating || generationError) {
        invalidateGeneration();
        updateGenerationFeedback();
      }
      const target = event.target as HTMLInputElement;
      if (target.id === 'item') document.querySelector('#quantity-unit')!.textContent = scenarioForItem(draft.item)?.unitLabel ?? 'units';
      target.setAttribute('aria-invalid', 'false');
      target.closest('.field')?.classList.remove('invalid');
      const error = document.querySelector(`#error-${target.name === 'supplier' ? 'suppliers' : target.id}`);
      if (error) error.textContent = '';
      if (target.name === 'supplier') {
        document.querySelector('#supplier-count')!.textContent = `${draft.supplierIds.length} selected`;
        target.closest('.supplier-option')?.classList.toggle('selected', target.checked);
      }
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitRequest(form);
    });
    document.querySelector('#sample')!.addEventListener('click', () => loadExample());
  } else if (step === 2) {
    document.querySelector('#restore-sample')?.addEventListener('click', () => loadExample(true));
    document.querySelector('#compare')?.addEventListener('click', () => {
      try {
        result = compareQuotes(request!, quotes, preference);
        step = 3;
        render(true);
      } catch (error) { showToast((error as Error).message); }
    });
  } else {
    document.querySelector('#back-quotes')!.addEventListener('click', () => { step = 2; render(true); });
  }
}

document.querySelector('#reset')!.addEventListener('click', () => {
  preference = 'lowest_cost';
  draft = { item: '', quantity: '', deadline: '', budget: '', supplierIds: [] };
  editRequest();
  showToast('A fresh request. Start with what you need.');
});

render();
void refreshConnection();
