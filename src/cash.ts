import '@fontsource-variable/dm-sans';
import './styles.css';
import './shipments.css';
import { demoNavigation } from './demo-navigation';

type Values = Record<string, unknown>;
interface SupplierBalance { supplier_id: number; supplier_key: string; name: string | null; currency: string; charged_minor: number; paid_minor: number; owed_minor: number; }
interface CashBalance { currency: string | null; opening_minor: number; opened_on: string | null; paid_out_minor: number; balance_minor: number; }
interface Workspace { suppliers: SupplierBalance[]; cash: CashBalance; }

const app = document.querySelector<HTMLDivElement>('#app')!;
const endpoint = '/api/cash';
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const text = (fields: FormData, name: string) => String(fields.get(name) ?? '').trim();
const whole = (fields: FormData, name: string, minimum: number, problem: string) => {
  const value = Number(text(fields, name));
  if (!text(fields, name) || !Number.isSafeInteger(value) || value < minimum) throw new Error(problem);
  return value;
};
const localDate = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };
// Amounts are stored as integer minor units; display uses the currency's own decimals.
const money = (minor: number, currency: string | null | undefined) => {
  if (!currency) return `${minor} minor units`;
  const format = new Intl.NumberFormat(undefined, { style: 'currency', currency });
  return format.format(minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
};
const input = (name: string, label: string, value: unknown = '', type = 'text', attributes = '') => `<label>${escape(label)}<input name="${escape(name)}" type="${type}" value="${escape(value)}" ${attributes}></label>`;
const button = (label: string, attributes = '', style = '') => `<button class="shipping-button ${style}" ${attributes}>${escape(label)}</button>`;
const empty = (title: string, help: string) => `<div class="shipping-empty"><strong>${escape(title)}</strong><p>${escape(help)}</p></div>`;
const table = (headers: string[], rows: unknown[][]) => rows.length ? `<div class="shipping-table-wrap"><table class="shipping-table"><thead><tr>${headers.map(header => `<th scope="col">${escape(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
let token = '';
let data: Workspace | undefined;
let busy = false;
let message = '';
let failed = false;
// Retain the logical request key until both its command and refreshed view succeed.
const pending = new Map<string, string>();
const completedRequests = new Set<string>();
const supplierName = (value: SupplierBalance) => value.name ?? value.supplier_key;
const payable = () => data?.suppliers.filter(value => value.owed_minor > 0) ?? [];

async function request<T>(path: string, body?: Values): Promise<T> {
  const identity = `${path}:${JSON.stringify(body)}`;
  const key = body ? pending.get(identity) ?? crypto.randomUUID() : undefined;
  if (key) pending.set(identity, key);
  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify({ ...body, idempotency_key: key }) } : {}) });
  } catch { throw new Error('Could not reach the cash server. Your input is unchanged. Retry the same request when the connection returns.'); }
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
  const [suppliers, cash] = await Promise.all([request<SupplierBalance[]>('/suppliers'), request<CashBalance>('/balance')]);
  data = { suppliers, cash };
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
  const controls = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')];
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
      ? 'The payment was saved, but the latest view could not be loaded. Retry with the same inputs, or select Refresh. The request key is retained to prevent duplicates.'
      : error instanceof Error ? error.message : 'The request could not be completed.', true);
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

function balancePanel() {
  const cash = data!.cash;
  return `<section class="shipping-panel"><h2>Cash balance</h2><p>Opening cash minus payments to suppliers. Customer payments are not recorded yet.</p>
    <dl class="shipping-dispatch-meta"><div><dt>Opening cash${cash.opened_on ? ` (${escape(cash.opened_on)})` : ''}</dt><dd>${escape(money(cash.opening_minor, cash.currency))}</dd></div><div><dt>Paid to suppliers</dt><dd>${escape(money(cash.paid_out_minor, cash.currency))}</dd></div><div><dt>Cash balance</dt><dd><strong>${escape(money(cash.balance_minor, cash.currency))}</strong></dd></div><div><dt>Currency</dt><dd>${escape(cash.currency ?? 'Not set yet')}</dd></div></dl></section>`;
}

function openingPanel() {
  const cash = data!.cash;
  if (cash.opened_on) return `<section class="shipping-panel"><h2>Opening cash</h2><p>Opening cash of ${escape(money(cash.opening_minor, cash.currency))} was recorded for ${escape(cash.opened_on)}. It can be recorded only once.</p></section>`;
  return `<section class="shipping-panel"><h2>Record opening cash</h2><p>The cash the business starts with, recorded once. Enter integer minor units: 100 means 1.00.</p>${cash.currency ? `<form id="opening-form"><div class="shipping-fields">${input('amount_minor', `Amount in minor units (${cash.currency})`, '', 'number', 'required min="0" step="1"')}${input('as_of', 'As of', localDate(), 'date', 'required')}</div>${button('Record opening cash')}</form>` : empty('Set the business currency first.', 'Complete Business setup & records, or receive a purchase, so the cash currency is known.')}</section>`;
}

function suppliersPanel() {
  const rows = data!.suppliers;
  return `<section class="shipping-panel shipping-wide"><div class="shipping-panel-heading"><div><h2>Supplier balances</h2><p>Receiving purchased goods charges the supplier's agreed line total. Payments reduce what is owed.</p></div><a class="shipping-button quiet small" href="/purchasing.html">Receive goods →</a></div>
    ${rows.length ? table(['Supplier', 'Charged for goods received', 'Paid', 'Owed'], rows.map(value => [supplierName(value), money(value.charged_minor, value.currency), money(value.paid_minor, value.currency), money(value.owed_minor, value.currency)])) : empty('No supplier charges yet.', 'Receive an approved purchase delivery in Purchasing to charge its supplier.')}</section>`;
}

function paymentPanel() {
  const suppliers = payable();
  return `<section class="shipping-panel shipping-wide"><h2>Pay a supplier</h2><p>Payments cannot exceed what the supplier is owed. Enter integer minor units: 100 means 1.00.</p>${suppliers.length ? `<form id="payment-form"><div class="shipping-fields"><label class="shipping-span">Supplier<select name="supplier_id" required><option value="">Select…</option>${suppliers.map(value => `<option value="${value.supplier_id}">${escape(supplierName(value))} · owed ${escape(money(value.owed_minor, value.currency))}</option>`).join('')}</select></label>${input('amount_minor', 'Amount in minor units', '', 'number', 'required min="1" step="1"')}${input('paid_on', 'Paid on', localDate(), 'date', 'required')}</div>${button('Record payment')}</form>` : empty('Nothing is owed to suppliers.', 'Supplier charges appear after goods are received.')}</section>`;
}

function render() {
  app.innerHTML = `<main class="shipping-page">${demoNavigation('cash')}<header class="shipping-header"><div><div class="eyebrow">CASH</div><h1>What we owe, what we hold.</h1><p>Supplier balances come from goods received. Payments and opening cash are saved once, even if a request is retried.</p></div>${data ? `<div class="shipping-actions">${button('Refresh','type="button" id="refresh"','quiet')}${button('Disconnect','type="button" id="disconnect"','quiet')}</div>` : ''}</header><div class="shipping-feedback${failed ? ' error' : ''}" role="status" aria-live="polite">${escape(message)}</div>
    ${!data ? `<section class="shipping-panel shipping-lock"><h2>Connect to your workspace</h2><p>Enter the same owner development token used for purchasing. It stays in this page’s memory and clears on disconnect or reload.</p><form id="connect-form"><div class="shipping-fields">${input('token','Owner development token','','password','required autocomplete="off" spellcheck="false"')}</div>${button('Connect')}</form></section>` : `<p class="shipping-note">Connected to the configured business database · Owner development access</p><div class="shipping-grid">${balancePanel()}${openingPanel()}${suppliersPanel()}${paymentPanel()}</div>`}</main>`;
  bind();
}

function bind() {
  bindForm('connect-form', async fields => { token = text(fields, 'token'); await request<CashBalance>('/balance'); }, 'Connected to your cash workspace.');
  document.querySelector('#disconnect')?.addEventListener('click', () => { token = ''; data = undefined; pending.clear(); completedRequests.clear(); message = ''; failed = false; render(); });
  document.querySelector('#refresh')?.addEventListener('click', () => { void run(async () => {}, 'Balances refreshed.'); });
  bindForm('opening-form', fields => request('/opening', {
    amount_minor: whole(fields, 'amount_minor', 0, 'Enter opening cash as a whole number of minor units, 0 or more.'),
    as_of: text(fields, 'as_of'),
  }), 'Opening cash recorded.');
  bindForm('payment-form', fields => {
    const supplier = payable().find(value => value.supplier_id === Number(text(fields, 'supplier_id')));
    if (!supplier) throw new Error('Select a supplier with an amount owed.');
    const amount = whole(fields, 'amount_minor', 1, 'Enter the payment as a positive whole number of minor units.');
    if (amount > supplier.owed_minor) throw new Error(`The payment exceeds the ${money(supplier.owed_minor, supplier.currency)} owed to ${supplierName(supplier)}.`);
    return request('/supplier-payments', { supplier_id: supplier.supplier_id, amount_minor: amount, paid_on: text(fields, 'paid_on') });
  }, 'Payment recorded. The supplier balance and cash balance are updated.');
}

render();
