import '@fontsource-variable/dm-sans';
import './styles.css';
import './purchasing.css';
import { demoNavigation } from './demo-navigation';

type Row = Record<string, unknown>;
interface Report { as_of: string; through: string; balance_basis: string; lots: Row[]; on_hand_by_risk: Record<string, number>; }
const app = document.querySelector<HTMLDivElement>('#app')!;
const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
let sequence = 0;
let references: Row[] = [];
const name = (id: unknown) => {
  const ref = references.find(r => r.id === id);
  const snapshot = ref?.snapshot as Row | undefined;
  return snapshot?.name ?? snapshot?.label ?? ref?.external_key ?? `#${id}`;
};
app.innerHTML = `<main class="purchasing-page">${demoNavigation('inventory')}<header class="purchasing-header"><div><div class="eyebrow">INVENTORY RISKS</div><h1>See stock that needs attention.</h1><p>Review held, expired and soon-expiring lots by location. Read-only: this page never releases a hold, changes stock or creates a purchase.</p></div></header><section class="purchasing-panel"><h2>Choose a review date</h2><p>The date classifies <strong>current balances</strong>. This is not a historical inventory snapshot. Lots expiring on the review date remain usable that day. A hold applies to the whole lot across locations. Held stock takes precedence over expiry, so units are never counted twice.</p><form id="risk-form"><div class="purchasing-fields"><label>Review date<input type="date" name="as_of" required value="${today()}"></label><label>Days ahead<input type="number" name="horizon_days" required min="0" max="366" step="1" value="30"></label><label>Item<select name="item_id"><option value="">All items</option></select></label><label>Location<select name="location_id"><option value="">All locations</option></select></label></div><button class="purchasing-button" type="submit">Review current stock</button></form></section><p id="risk-status" role="status" aria-live="polite"></p><section id="risk-result" class="purchasing-panel" hidden></section><p class="purchasing-note">Only lot-tracked stock with a positive current balance appears. Untracked stock and depleted lots are excluded. Use shipping and purchasing for their existing workflows. This workspace retains the owner-development authentication boundary; it is not new production tenant routing.</p></main>`;
const form = document.querySelector<HTMLFormElement>('#risk-form')!;
const status = document.querySelector<HTMLParagraphElement>('#risk-status')!;
const result = document.querySelector<HTMLElement>('#risk-result')!;
async function get(path: string) {
  const response = await fetch('/api/purchasing'+path);
  const body = await response.json();
  if (!response.ok) {
    const detail = Array.isArray(body.detail)
      ? body.detail.map((issue: { loc?: unknown[]; msg?: string }) => `${issue.loc?.slice(1).join('.') ?? 'Request'}: ${issue.msg ?? 'invalid value'}`).join('; ')
      : typeof body.detail === 'string' ? body.detail : undefined;
    throw new Error(body.error?.message ?? detail ?? `Request failed (${response.status})`);
  }
  return body;
}
async function review() {
  if (!form.reportValidity()) return;
  const ownSequence = ++sequence;
  // Hide old quantities before loading so a failed refresh cannot look current.
  result.hidden = true;
  status.textContent = 'Loading current stock…';
  const params = new URLSearchParams();
  new FormData(form).forEach((value,key) => { if (String(value)) params.set(key,String(value)); });
  try {
    const report: Report = await get('/lot-risks?'+params);
    if (ownSequence !== sequence) return;
    if (report.balance_basis !== 'current') throw new Error('Unsupported balance basis. No quantities displayed.');
    const labels: Record<string,string> = {held:'Held',expired:'Expired',expiring:'Expiring soon'};
    result.innerHTML = `<h2>Current stock reviewed for ${escape(report.as_of)} through ${escape(report.through)}</h2><p>${Object.entries(labels).map(([key,label]) => `${label}: ${escape(report.on_hand_by_risk[key])} units`).join(' · ')}</p>${report.lots.length ? `<div class="purchasing-table-wrap"><table class="purchasing-table"><thead><tr>${['Risk','Item','Location','Lot','Expiry','On hand','Allocated','Unallocated','Usable available'].map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${report.lots.map(row=>`<tr>${[labels[String(row.risk)] ?? row.risk,name(row.item_id),name(row.location_id),row.lot_number,row.expiry_date ?? 'No expiry',row.on_hand,row.allocated,row.unallocated,row.usable_available].map(v=>`<td>${escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p>No matching lots need attention for these filters. This does not certify untracked stock.</p>'}<p>Held and expired stock has zero usable available units. Allocated quantities are still part of on-hand stock, not extra units.</p>`;
    result.hidden = false;
    status.textContent = 'Current stock loaded. No inventory was changed.';
  } catch (error) {
    if (ownSequence !== sequence) return;
    status.textContent = error instanceof Error ? error.message : 'Could not load current stock. Please retry.';
    result.replaceChildren();
  }
}
form.addEventListener('submit', e => { e.preventDefault(); void review(); });
async function start() {
  try {
    const workspace = await get('/workspace');
    references = workspace.references;
    for (const kind of ['item','location']) {
      const select = form.querySelector<HTMLSelectElement>(`[name="${kind}_id"]`)!;
      for (const ref of references.filter(r => r.kind === kind)) {
        const option = document.createElement('option'); option.value = String(ref.id); option.textContent = String(name(ref.id)); select.append(option);
      }
    }
  } catch {
    // The risk endpoint can still work when optional display labels are unavailable.
    status.textContent = 'Reference labels unavailable. Lot IDs will be shown.';
  }
  await review();
}
void start();
