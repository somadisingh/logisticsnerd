import '@fontsource-variable/dm-sans';
import './styles.css';
import { mockQuotes, requestFromDraft, sampleDraft, suppliers } from './data';
import { compareQuotes } from './domain/compare';
import { dateLabel, evaluationReason, money } from './domain/reasons';
import type { ComparisonResult, DraftErrors, Evaluation, ProcurementRequest, RequestDraft, SupplierQuote } from './domain/model';
import { validateDraft } from './domain/validate';
import { brandMark, icon } from './icons';

type Step = 1 | 2 | 3;
let step: Step = 1;
let draft = sampleDraft();
let request: ProcurementRequest | null = null;
let quotes: SupplierQuote[] = [];
let result: ComparisonResult | null = null;
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
      <div><div class="eyebrow"><span class="eyebrow-line"></span>PROCUREMENT, SIMPLIFIED</div><h1 id="page-title">The right supplier.<br><span>A clearer decision.</span></h1><p class="intro-copy">Find the lowest price that meets your quantity<br class="desktop-break"> and delivery deadline. See exactly why it wins.</p></div>
      <div class="intro-note"><div class="note-symbol">${icon('shield')}</div><div><strong>Clear rules. Confident choices.</strong><p>Every recommendation comes<br>with a reason you can inspect.</p></div></div>
    </section>
    <nav class="steps" aria-label="Procurement progress" id="steps"></nav>
    <div class="workspace" id="workspace"></div>
    <footer class="footer"><span>${icon('box')} A small step toward a better buy.</span><span>Fictional quotes · USD · No suppliers contacted</span></footer>
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

function requestView(): string {
  return `
    <section class="panel form-panel enter">
      <div class="panel-heading"><div><div class="section-kicker">LET'S START WITH THE ESSENTIALS</div><h2 class="section-title" tabindex="-1">What do you need?</h2><p>One item. A few suppliers. A decision that makes sense.</p></div><span class="section-symbol">${icon('box')}</span></div>
      <form id="request-form" novalidate>
        <div class="form-fields">
          <div class="field"><label for="item">Item name</label><div class="input-wrap">${icon('box')}<input id="item" name="item" type="text" maxlength="160" value="${escape(draft.item)}" placeholder="e.g. Office chairs" required aria-describedby="error-item" /></div>${fieldError('item')}</div>
          <div class="field-grid"><div class="field"><label for="quantity">Quantity</label><div class="input-wrap"><input id="quantity" name="quantity" type="number" min="1" step="1" value="${escape(draft.quantity)}" required aria-describedby="error-quantity" /><span class="input-suffix">units</span></div>${fieldError('quantity')}</div><div class="field"><label for="deadline">Required by</label><div class="input-wrap">${icon('calendar')}<input id="deadline" name="deadline" type="date" value="${escape(draft.deadline)}" required aria-describedby="error-deadline" /></div>${fieldError('deadline')}</div></div>
          <div class="field budget-field"><label for="budget">Maximum budget <span class="optional">Optional</span></label><div class="input-wrap"><span class="currency-prefix">$</span><input id="budget" name="budget" type="number" min="0" step="0.01" value="${escape(draft.budget)}" placeholder="No budget limit" aria-describedby="budget-help error-budget" /><span class="input-suffix">USD</span></div><span class="field-help" id="budget-help">Leave blank to compare without a budget limit.</span>${fieldError('budget')}</div>
        </div>
        <fieldset class="supplier-section" aria-describedby="error-suppliers"><legend>Choose your suppliers <span class="supplier-count" id="supplier-count">${draft.supplierIds.length} selected</span></legend><p>These are the three suppliers in the chair example.</p><div class="supplier-options">${suppliers.map((supplier, index) => `<label class="supplier-option ${draft.supplierIds.includes(supplier.id) ? 'selected' : ''}"><input type="checkbox" name="supplier" value="${supplier.id}" ${draft.supplierIds.includes(supplier.id) ? 'checked' : ''} /><span class="supplier-avatar avatar-${index}">${supplier.initials}</span><span class="supplier-option-name">${escape(supplier.name)}</span><span class="custom-checkbox">${icon('check')}</span></label>`).join('')}</div>${fieldError('suppliers')}</fieldset>
        <div class="form-bottom"><button class="text-button" id="sample" type="button">${icon('spark')}Use chair example</button><button class="button button-primary" type="submit">Review supplier quotes ${icon('arrow')}</button></div>
      </form>
    </section>
    <aside class="aside enter" style="--delay: 70ms">
      <section class="guide-panel"><div class="guide-top"><span class="guide-label">A BETTER WAY TO COMPARE</span><span class="guide-orbit">${icon('spark')}</span></div><h2>Price matters.<br>So does the promise.</h2><p class="guide-copy">A low price only helps if the supplier can meet your needs.</p><div class="guide-rules"><div><span class="guide-rule-icon">${icon('box')}</span><span><strong>The right quantity</strong><small>Enough to fulfill your request.</small></span><span class="rule-index">01</span></div><div><span class="guide-rule-icon">${icon('calendar')}</span><span><strong>On time</strong><small>Delivered by your deadline.</small></span><span class="rule-index">02</span></div><div><span class="guide-rule-icon">${icon('money')}</span><span><strong>The lowest feasible price</strong><small>Within your budget, if you set one.</small></span><span class="rule-index">03</span></div></div><div class="guide-bottom"><span class="tiny-dot"></span>Simple rules. No guesswork.</div></section>
      <section class="sample-note"><span class="sample-note-icon">${icon('info')}</span><div><strong>A small, focused demo</strong><p>Start with 50 office chairs. The supplier quotes are fictional, and nothing is sent externally.</p></div></section>
    </aside>`;
}

function requestSummary(): string {
  if (!request) return '';
  const item = request.items[0];
  return `<section class="summary-panel"><div class="summary-heading"><span class="section-kicker">YOUR REQUEST</span><button class="icon-button" type="button" data-edit aria-label="Edit your request">${icon('edit')}</button></div><h3>${escape(item.name)}</h3><dl><div><dt>Quantity</dt><dd>${item.quantity} units</dd></div><div><dt>Required by</dt><dd>${dateLabel(item.requiredDate, true)}</dd></div><div><dt>Budget</dt><dd>${request.maxBudgetCents === null ? 'No limit set' : money(request.maxBudgetCents)}</dd></div><div><dt>Suppliers</dt><dd>${request.selectedSupplierIds.length} selected</dd></div></dl></section>`;
}

function quoteCard(quote: SupplierQuote, index: number): string {
  const supplier = suppliers.find((value) => value.id === quote.supplierId)!;
  const line = quote.items[0];
  return `<article class="quote-card" style="--delay: ${index * 55}ms"><div class="quote-card-top"><span class="supplier-avatar avatar-${index}">${supplier.initials}</span><div><h3>${escape(supplier.name)}</h3><span class="quote-reference">QUOTE 0${index + 1}</span></div><span class="response-status"><span></span>Received</span></div><div class="quote-card-body"><div><span class="metric-label">QUOTED TOTAL</span><strong class="quote-price">${money(line.price.cents)}</strong></div><div class="quote-facts"><span>${icon('box')}<span><strong>${line.availableQuantity} units</strong><small>Available quantity</small></span></span><span>${icon('calendar')}<span><strong>${dateLabel(line.expectedDate, true)}</strong><small>Expected delivery</small></span></span></div></div></article>`;
}

function quotesView(): string {
  return `<section class="panel quotes-panel enter"><div class="panel-heading"><div><div class="section-kicker">THE OFFERS ARE IN</div><h2 class="section-title" tabindex="-1">A closer look at your quotes.</h2><p>Compare the facts before making the call.</p></div><span class="section-symbol">${icon('list')}</span></div><div class="inline-notice">${icon('info')}<span>Demo responses for 50 office chairs. No suppliers were contacted.</span></div>${quotes.length ? `<div class="quote-list">${quotes.map(quoteCard).join('')}</div><p class="quote-convention">Quoted totals are in USD and assumed to include all charges.</p><div class="panel-actions"><button type="button" class="text-button" data-edit>${icon('back')}Edit request</button><button class="button button-primary" id="compare" type="button">Find the best supplier ${icon('arrow')}</button></div>` : `<div class="empty-state"><span class="empty-icon">${icon('box')}</span><h3>No demo quotes for this request.</h3><p>The sample responses apply to 50 office chairs. We won't reuse those prices for a different item or quantity.</p><button class="button button-primary" id="restore-sample" type="button">Use the chair example ${icon('arrow')}</button><button class="text-button" data-edit type="button">${icon('back')}Edit your request</button></div>`}</section><aside class="aside enter" style="--delay: 70ms">${requestSummary()}<section class="quiet-note">${icon('shield')}<h3>Facts first. Decisions second.</h3><p>We'll check quantity, delivery, and your optional budget, then compare the quotes that qualify.</p><span class="note-rule">Lowest price → earlier delivery if tied</span></section></aside>`;
}

function evaluationRow(value: Evaluation, index: number): string {
  if (!request || !result) return '';
  const supplier = suppliers.find((item) => item.id === value.supplierId)!;
  const recommended = result.recommendedSupplierIds.includes(value.supplierId);
  const item = request.items[0];
  const status = recommended ? result.outcome === 'tied' ? 'Tied best' : 'Recommended' : value.feasible ? 'Feasible' : 'Not feasible';
  const quantityPass = value.availableQuantity >= item.quantity;
  const datePass = value.expectedDate <= item.requiredDate;
  return `<article class="evaluation-row ${recommended ? 'is-recommended' : ''} ${!value.feasible ? 'is-rejected' : ''}" style="--delay:${index * 45}ms"><div class="evaluation-top"><div class="supplier-identity"><span class="supplier-avatar avatar-${index}">${supplier.initials}</span><div><h3>${escape(supplier.name)}</h3><span class="status-pill ${recommended ? 'recommended' : value.feasible ? 'feasible' : 'rejected'}">${icon(recommended ? 'checkCircle' : value.feasible ? 'check' : 'minus')}${status}</span></div></div><strong class="evaluation-price">${money(value.totalCents)}</strong></div><div class="evaluation-facts"><span class="fact ${quantityPass ? '' : 'failed'}">${icon(quantityPass ? 'check' : 'x')}${value.availableQuantity} of ${item.quantity} units</span><span class="fact ${datePass ? '' : 'failed'}">${icon(datePass ? 'check' : 'x')}Delivery ${dateLabel(value.expectedDate, true)}</span>${request.maxBudgetCents !== null ? `<span class="fact ${value.totalCents <= request.maxBudgetCents ? '' : 'failed'}">${icon(value.totalCents <= request.maxBudgetCents ? 'check' : 'x')}${value.totalCents <= request.maxBudgetCents ? 'Within budget' : 'Over budget'}</span>` : ''}</div><p class="evaluation-reason">${escape(evaluationReason(value, result, request))}</p></article>`;
}

function decisionAside(): string {
  if (!request || !result) return '';
  const best = result.feasible[0];
  if (!best) return `${requestSummary()}<section class="quiet-note">${icon('info')}<h3>Review the constraints.</h3><p>You can adjust the deadline or budget, review the quantity, or request quotes from other suppliers.</p><button class="text-button" data-edit type="button">Edit request ${icon('arrow')}</button></section>`;
  const item = request.items[0];
  return `<section class="decision-panel"><div class="guide-top"><span class="guide-label">WHY THIS ${result.outcome === 'tied' ? 'PRICE' : 'QUOTE'} WORKS</span>${icon('shield')}</div><h3>Every requirement.<br>Accounted for.</h3><div class="decision-check"><span>${icon('check')}</span><div><strong>Quantity met</strong><small>${best.availableQuantity} available · ${item.quantity} required</small></div></div><div class="decision-check"><span>${icon('check')}</span><div><strong>Deadline met</strong><small>${dateLabel(best.expectedDate, true)} delivery · ${dateLabel(item.requiredDate, true)} deadline</small></div></div>${request.maxBudgetCents !== null ? `<div class="decision-check"><span>${icon('check')}</span><div><strong>Within your budget</strong><small>${money(best.totalCents)} total · ${money(request.maxBudgetCents)} limit</small></div></div>` : ''}<div class="decision-bottom">${icon('checkCircle')}Lowest total among feasible quotes</div></section>${requestSummary()}`;
}

function resultsView(): string {
  if (!request || !result) return '';
  const best = result.feasible[0];
  const alternative = result.feasible.find((value) => !result!.recommendedSupplierIds.includes(value.supplierId));
  const savings = best && alternative ? alternative.totalCents - best.totalCents : 0;
  const hasWinner = !!best;
  const tied = result.outcome === 'tied';
  let banner: string;
  if (best) {
    banner = `<div class="winner-banner"><div class="winner-label">${icon('checkCircle')} ${tied ? 'TIED CHEAPEST FEASIBLE QUOTES' : 'YOUR RECOMMENDED SUPPLIER'}</div><div class="winner-main"><div><h3>${escape(tied ? result.recommendedSupplierIds.map(supplierName).join(' & ') : supplierName(best.supplierId))}</h3><p>${tied ? 'Same price and delivery date. Choose either for the full order.' : `${request.items[0].quantity} units · Delivery ${dateLabel(best.expectedDate, true)}`}</p></div><div class="winner-cost"><strong>${money(best.totalCents)}</strong><span>quoted total</span></div></div>${savings > 0 ? `<div class="winner-saving">${icon('spark')} ${money(savings)} less than the next feasible quote</div>` : '<div class="winner-saving">'+icon('check')+' The lowest price that meets your requirements</div>'}</div>`;
  } else {
    banner = `<div class="no-winner-banner"><span class="empty-icon">${icon('info')}</span><div><h3>No quote meets every requirement.</h3><p>Review the reasons below, then adjust your request or supplier set.</p></div></div>`;
  }
  return `<section class="panel results-panel enter"><div class="panel-heading"><div><div class="section-kicker">THE COMPARISON, MADE CLEAR</div><h2 class="section-title" tabindex="-1">${hasWinner ? tied ? 'Two equally good fits.' : 'A clear choice.' : 'Let’s find another fit.'}</h2><p>${hasWinner ? 'The best price among the quotes that meet your needs.' : 'The constraints matter as much as the price.'}</p></div><span class="section-symbol">${icon(hasWinner ? 'checkCircle' : 'info')}</span></div>${banner}<div class="comparison-heading"><h3>Every quote, explained</h3><span>${result.feasible.length} of ${result.evaluations.length} feasible</span></div><div class="evaluation-list">${result.evaluations.map(evaluationRow).join('')}</div><div class="result-disclosure">${icon('info')}Based on fictional supplier promises. This is a recommendation, not an order.</div><div class="panel-actions"><button class="text-button" type="button" id="back-quotes">${icon('back')}Review quotes</button><button class="button button-secondary" type="button" data-edit>${icon('edit')}Adjust your request</button></div></section><aside class="aside enter" style="--delay: 70ms">${decisionAside()}</aside>`;
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
  step = 1;
  request = null;
  quotes = [];
  result = null;
  render(true);
}

function loadExample(goToQuotes = false): void {
  draft = sampleDraft();
  request = null;
  quotes = [];
  result = null;
  step = 1;
  if (goToQuotes) {
    request = requestFromDraft(draft);
    quotes = mockQuotes(request);
    step = 2;
  }
  render(goToQuotes);
  showToast('Chair example loaded. You’re ready to compare.');
}

function bindStep(): void {
  workspace.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((button) => button.addEventListener('click', editRequest));
  if (step === 1) {
    const form = document.querySelector<HTMLFormElement>('#request-form')!;
    form.addEventListener('input', (event) => {
      draft = readDraft(form);
      const target = event.target as HTMLInputElement;
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
      draft = readDraft(form);
      const errors = validateDraft(draft);
      showErrors(errors);
      if (Object.keys(errors).length) {
        const first = Object.keys(errors)[0];
        const element = first === 'suppliers' ? form.querySelector<HTMLInputElement>('input[name="supplier"]') : form.querySelector<HTMLInputElement>(`#${first}`);
        element?.focus();
        return;
      }
      request = requestFromDraft(draft);
      quotes = mockQuotes(request);
      result = null;
      step = 2;
      render(true);
    });
    document.querySelector('#sample')!.addEventListener('click', () => loadExample());
  } else if (step === 2) {
    document.querySelector('#restore-sample')?.addEventListener('click', () => loadExample(true));
    document.querySelector('#compare')?.addEventListener('click', () => {
      try {
        result = compareQuotes(request!, quotes);
        step = 3;
        render(true);
      } catch (error) { showToast((error as Error).message); }
    });
  } else {
    document.querySelector('#back-quotes')!.addEventListener('click', () => { step = 2; render(true); });
  }
}

document.querySelector('#reset')!.addEventListener('click', () => {
  draft = { item: '', quantity: '', deadline: '', budget: '', supplierIds: [] };
  editRequest();
  showToast('A fresh request. Start with what you need.');
});

render();
