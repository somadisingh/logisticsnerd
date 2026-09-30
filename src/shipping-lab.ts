import '@fontsource-variable/dm-sans';
import './styles.css';
import './shipping-lab.css';
import { brandMark, icon } from './icons';

interface Access { id: string; name: string; ready: boolean; detail: string; docs: string }
interface Rate {
  carrier: string; service: string; costCents: number | null; currency: string | null;
  deliveryDate: string | null; earliestDate: string | null; latestDate: string | null;
  providerReportedDate?: string | null; transitDays: number | null; deliveryWindow: string | null;
  deadlineAssessment: string;
}
interface ProviderResult {
  provider: string; name: string; status: string; mode: string; cached: boolean; checkedAt: string;
  durationMs: number; traces: { httpStatus: number }[]; rates: Rate[]; notices: string[];
}
interface Report {
  checkedAt: string;
  parcel: { fromPostal: string; toPostal: string; pickupTime: string; deadline: string };
  results: ProviderResult[];
}

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const deadline = new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10);
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="header"><a class="brand" href="/" aria-label="LogisticsNerd home">${brandMark}<span>logistics<span class="brand-light">nerd</span><span class="brand-dot">.</span></span></a><span class="header-center">Shipping API comparison</span><a class="text-button" href="/">${icon('back')}Supplier demo</a></header>
  <main class="page lab-page">
    <section class="lab-intro"><div class="eyebrow"><span class="eyebrow-line"></span>A SMALL, MEASURABLE EXPERIMENT</div><h1>Three APIs.<br><span>One parcel to compare.</span></h1><p>Test access, shipping rates, and delivery estimates with the same package. <br>US domestic · one packed parcel · shipping costs only.</p></section>
    <section class="panel lab-setup" aria-labelledby="setup-title"><div class="lab-section-heading"><div><span class="section-kicker">PROVIDER ACCESS</span><h2 id="setup-title">Ready for a fair test?</h2></div><button class="text-button" id="check-setup" type="button">${icon('reset')}Check setup</button></div><div id="access" class="lab-access" aria-live="polite"></div></section>
    <section class="panel lab-inputs"><div class="lab-section-heading"><div><span class="section-kicker">THE SAME INPUTS</span><h2>Describe the packed parcel.</h2></div><span class="section-symbol">${icon('box')}</span></div>
      <form id="parcel-form"><div class="field"><label for="product">Parcel contents</label><div class="input-wrap"><input id="product" name="product" value="One packed parcel of office stationery" maxlength="160" required></div><span class="field-help">Sample measurements below are hypothetical. Enter measured values for a real estimate.</span></div>
        <div class="field-grid"><div class="field"><label for="fromPostal">Origin ZIP</label><div class="input-wrap"><input id="fromPostal" name="fromPostal" value="07102" inputmode="numeric" pattern="[0-9]{5}" required></div></div><div class="field"><label for="toPostal">Destination ZIP</label><div class="input-wrap"><input id="toPostal" name="toPostal" value="30303" inputmode="numeric" pattern="[0-9]{5}" required></div></div></div>
        <div class="lab-dimensions">${[['lengthCm','Length','30'],['widthCm','Width','20'],['heightCm','Height','10'],['weightKg','Weight','1']].map(([id,label,value]) => `<div class="field"><label for="${id}">${label} (${id === 'weightKg' ? 'kg' : 'cm'})</label><div class="input-wrap"><input id="${id}" name="${id}" type="number" value="${value}" min="0.01" max="10000" step="0.01" required></div></div>`).join('')}</div>
        <div class="field-grid"><div class="field"><label for="pickupTime">Planned carrier pickup</label><div class="input-wrap"><input id="pickupTime" name="pickupTime" type="datetime-local" value="${tomorrow}T10:00" required></div><span class="field-help">Local time at the origin. SMKlog does not accept this input.</span></div><div class="field"><label for="deadline">Delivery deadline</label><div class="input-wrap"><input id="deadline" name="deadline" type="date" value="${deadline}" required></div></div></div>
        <details class="lab-details"><summary>Carrier and address details</summary><p>AfterShip predicts one chosen carrier. EasyPost may need street addresses for some carrier rates.</p><div class="field-grid"><div class="field"><label for="carrier">AfterShip carrier</label><select id="carrier" name="carrier"><option value="ups">UPS</option><option value="usps">USPS</option><option value="fedex">FedEx</option></select></div><div class="field"><label for="service">AfterShip service code (optional)</label><div class="input-wrap"><input id="service" name="service" maxlength="160" placeholder="Use a provider-supported service name"></div></div><div class="field"><label for="fromStreet">Origin street (optional)</label><div class="input-wrap"><input id="fromStreet" name="fromStreet" maxlength="160"></div></div><div class="field"><label for="toStreet">Destination street (optional)</label><div class="input-wrap"><input id="toStreet" name="toStreet" maxlength="160"></div></div></div></details>
        <p class="lab-error" id="lab-message" role="status" aria-live="polite"></p><div class="lab-actions"><span>EasyPost uses test mode. AfterShip and SMKlog use live endpoints.</span><button class="button button-primary" type="submit" id="run-comparison" disabled>Run API comparison ${icon('arrow')}</button></div>
      </form></section>
    <section id="lab-results" aria-live="polite"></section>
    <footer class="footer"><span>${icon('shield')}Provider estimates, not supplier delivery promises.</span><span>Local comparison · no labels purchased</span></footer>
  </main>`;

const form = document.querySelector<HTMLFormElement>('#parcel-form')!;
const runButton = document.querySelector<HTMLButtonElement>('#run-comparison')!;
const setupButton = document.querySelector<HTMLButtonElement>('#check-setup')!;
const message = document.querySelector<HTMLElement>('#lab-message')!;
let running = false;

function updateRunButton(): void {
  runButton.disabled = running || !document.querySelector('#access input:checked');
}

async function checkSetup(): Promise<void> {
  setupButton.disabled = true;
  try {
    const response = await fetch('/api/shipping/status');
    if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) throw new Error('Start the app with npm run dev or npm run preview to use the local API adapter.');
    const data: { providers: Access[] } = await response.json();
    document.querySelector('#access')!.innerHTML = data.providers.map((p) => `<article class="lab-provider"><div class="lab-provider-heading"><h3>${escape(p.name)}</h3><span class="lab-badge ${p.ready ? 'is-ready' : ''}">${p.ready ? 'Ready' : p.id === 'smklog' ? 'Access blocked' : 'Setup needed'}</span></div><p>${escape(p.detail)}</p><div class="lab-provider-bottom"><label><input type="checkbox" name="provider" value="${escape(p.id)}" ${p.ready ? 'checked' : 'disabled'}>Include ${escape(p.name)}</label><a href="${escape(p.docs)}" target="_blank" rel="noreferrer">Docs ↗</a></div></article>`).join('');
    document.querySelectorAll('#access input').forEach((input) => input.addEventListener('change', updateRunButton));
    message.textContent = data.providers.some((p) => p.ready) ? '' : 'No provider is ready yet. Add credentials or restore access, then check setup.';
  } catch (error) { message.textContent = (error as Error).message; }
  finally { setupButton.disabled = false; updateRunButton(); }
}

function renderRate(r: Rate): string {
  const cost = r.costCents === null || !r.currency ? 'Price not supplied' : new Intl.NumberFormat('en-US', { style: 'currency', currency: r.currency }).format(r.costCents / 100);
  const date = r.earliestDate && r.latestDate ? `${r.earliestDate} – ${r.latestDate}` : r.deliveryDate ?? 'No planned-date estimate';
  const assessment: Record<string,string> = { estimated_on_time: 'Estimated within deadline', estimated_late: 'Estimated after deadline', uncertain: 'Window crosses deadline', unknown: 'Deadline suitability unknown' };
  return `<div class="lab-rate"><div><strong>${escape(r.carrier)} · ${escape(r.service)}</strong><span>${escape(cost)}</span></div><p>${escape(date)}</p>${r.transitDays !== null || r.deliveryWindow ? `<p>Provider transit: ${escape(r.deliveryWindow ?? `${r.transitDays} days`)}</p>` : ''}${r.providerReportedDate ? `<p>Provider-reported date: ${escape(r.providerReportedDate)} (not matched to planned pickup)</p>` : ''}<small>${escape(assessment[r.deadlineAssessment] ?? assessment.unknown)}</small></div>`;
}

function renderReport(report: Report): void {
  const allSucceeded = report.results.length === 3 && report.results.every((r) => r.status === 'ok');
  document.querySelector('#lab-results')!.innerHTML = `<section class="panel lab-report"><div class="lab-section-heading"><div><span class="section-kicker">OBSERVED RESULTS</span><h2>What the APIs actually returned.</h2><p>Last submitted parcel: ${escape(report.parcel.fromPostal)} → ${escape(report.parcel.toPostal)} · pickup ${escape(report.parcel.pickupTime.replace('T',' '))} · deadline ${escape(report.parcel.deadline)}</p></div></div><div class="lab-outcome">${allSucceeded ? 'All three returned data. Compare coverage below; EasyPost test results do not establish live accuracy.' : 'The comparison is incomplete. Access failures and missing credentials cannot establish a winning provider.'}</div><div class="lab-result-grid">${report.results.map((r) => `<article class="lab-provider"><div class="lab-provider-heading"><h3>${escape(r.name)}</h3><span class="lab-badge ${r.status === 'ok' ? 'is-ready' : ''}">${escape(r.status.replaceAll('_',' '))}</span></div><p>${escape(r.mode)} · ${r.cached ? 'Cached result' : `${r.traces.length} API calls`} · ${(r.durationMs / 1000).toFixed(2)}s${r.traces.length ? ` · HTTP ${r.traces.map((t) => t.httpStatus).join(', ')}` : ''}</p>${r.rates.map(renderRate).join('')}${r.notices.map((notice) => `<p class="lab-notice">${escape(notice)}</p>`).join('')}<small>Checked ${escape(r.checkedAt)}</small></article>`).join('')}</div></section>`;
}

setupButton.addEventListener('click', checkSetup);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (running || !form.reportValidity()) return;
  const fields = new FormData(form);
  const parcel: Record<string, string | number> = {};
  for (const [key, value] of fields) parcel[key] = ['lengthCm','widthCm','heightCm','weightKg'].includes(key) ? Number(value) : String(value);
  const selected = [...document.querySelectorAll<HTMLInputElement>('#access input:checked')].map((input) => input.value);
  running = true; updateRunButton(); setupButton.disabled = true;
  message.textContent = 'Contacting the selected providers…';
  runButton.textContent = 'Comparing…';
  try {
    const response = await fetch('/api/shipping/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parcel, providers: selected }), signal: AbortSignal.timeout(130000) });
    if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('The local API adapter is unavailable.');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'The comparison could not be completed.');
    renderReport(body as Report);
    message.textContent = 'Comparison recorded. Edit inputs and run again to test another parcel.';
  } catch (error) { message.textContent = (error as Error).name === 'TimeoutError' ? 'The comparison timed out. Check server output before trying again.' : (error as Error).message; }
  finally { running = false; updateRunButton(); setupButton.disabled = false; runButton.innerHTML = `Run API comparison ${icon('arrow')}`; }
});

void checkSetup();
