import '@fontsource-variable/dm-sans';
import './styles.css';
import './business.css';
import { demoNavigation } from './demo-navigation';

type FieldType = 'text' | 'integer' | 'money' | 'boolean' | 'date' | 'reference';
type Values = Record<string, unknown>;
interface Field { slug: string; label: string; type: FieldType; required: boolean; unique: boolean; target_table?: string | null; min_value?: number | null; }
interface BusinessTable { slug: string; label: string; role: string; version: number; fields: Field[]; }
interface BusinessSetup { business_name: string; currency: string; business_type?: string; uses_inventory?: boolean; setup_notes?: string; }
interface Catalog { setup: BusinessSetup | null; tables: BusinessTable[]; integration?: unknown; }
interface BusinessRecord { id: number; version: number; archived: boolean; values: Values; system?: Values; }

const app = document.querySelector<HTMLDivElement>('#app')!;
const endpoint = '/api/business';
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
let loading = true;
let catalog: Catalog | undefined;
let records = new Map<string, BusinessRecord[]>();
let selected = '';
let editing: number | null = null;
let busy = false;
let message = '';
let failed = false;
let showSetup = false;
let includeArchived = false;
// Keep a logical request's identity through network failures. Never retain credentials.
const pending = new Map<string, string>();
const completedRequests = new Set<string>();
const currentTable = () => catalog?.tables.find(table => table.slug === selected);
const input = (name: string, label: string, value: unknown = '', type = 'text', attributes = '') => `<label>${escape(label)}<input name="${escape(name)}" type="${type}" value="${escape(value)}" ${attributes}></label>`;
const button = (label: string, attributes = '', style = '') => `<button class="business-button ${style}" ${busy ? 'disabled' : ''} ${attributes}>${escape(label)}</button>`;
const optional = (value: string) => value ? value : undefined;
const formText = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const status = (record: BusinessRecord) => String(record.system?.status ?? record.values.status ?? '');
const frozen = (table: BusinessTable, record: BusinessRecord) => table.slug === 'customer_orders' ? status(record) === 'submitted' : table.slug === 'customer_order_lines' && (records.get('customer_orders') ?? []).some(order => order.id === Number(record.values.order_id) && status(order) === 'submitted');

async function request(path: string, method = 'GET', body?: Values): Promise<unknown> {
  const identity = `${method}:${path}:${JSON.stringify(body)}`;
  const key = body ? pending.get(identity) ?? crypto.randomUUID() : undefined;
  if (key) pending.set(identity, key);
  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify({ ...body, idempotency_key: key }) } : {}),
    });
  } catch {
    throw new Error('Could not reach the business server. Your input is unchanged. Retry the same request when the connection returns.');
  }
  let value: { error?: { message?: string; fields?: { location: unknown[]; message: string }[] }; detail?: string };
  try { value = await response.json(); } catch { throw new Error(`The server could not complete this request (${response.status}).`); }
  if (!response.ok) {
    const issues = value.error?.fields?.map(issue => `${issue.location.slice(1).join('.')}: ${issue.message}`).join('; ');
    throw new Error(issues || value.error?.message || value.detail || 'The request could not be completed.');
  }
  // Keep the key until the following refresh succeeds too. Otherwise a saved
  // record followed by a failed refresh could be created twice on retry.
  if (body) completedRequests.add(identity);
  return value;
}

async function refresh() {
  const next = await request('/catalog') as Catalog;
  const nextRecords = new Map<string, BusinessRecord[]>();
  // Definitions decide which forms and relationships exist, including new user tables.
  await Promise.all(next.tables.map(async table => {
    const value = await request(`/tables/${encodeURIComponent(table.slug)}/records?include_archived=true`) as { records: BusinessRecord[] };
    nextRecords.set(table.slug, value.records);
  }));
  catalog = next;
  records = nextRecords;
  if (!next.tables.some(table => table.slug === selected)) selected = next.tables[0]?.slug ?? '';
}

function recordLabel(record: BusinessRecord, tableSlug: string) {
  const table = catalog?.tables.find(item => item.slug === tableSlug);
  const preferred = ['name', 'order_number', 'sku', 'title', 'email'];
  for (const key of preferred) if (record.values[key]) return `${record.values[key]}${record.archived ? ' (archived)' : ''}`;
  const first = table?.fields.find(field => field.type === 'text' && record.values[field.slug]);
  return `${first ? record.values[first.slug] : `Record #${record.id}`}${record.archived ? ' (archived)' : ''}`;
}

function displayValue(field: Field, value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'reference') {
    const record = records.get(field.target_table ?? '')?.find(item => item.id === Number(value));
    return record ? recordLabel(record, field.target_table!) : `Record #${value}`;
  }
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  if (field.type === 'money') return `${value} minor units`;
  return String(value);
}

function recordControl(field: Field, value: unknown) {
  const required = field.required ? 'required' : '';
  const name = `record_${field.slug}`;
  let control = '';
  let help = field.unique ? 'Must be unique.' : '';
  if (field.type === 'reference') {
    const choices = (records.get(field.target_table ?? '') ?? []).filter(record => (!record.archived || record.id === Number(value)) && !(selected === 'customer_order_lines' && field.slug === 'order_id' && status(record) === 'submitted' && record.id !== Number(value)));
    const target = catalog?.tables.find(table => table.slug === field.target_table);
    control = `<select name="${escape(name)}" ${required}><option value="">${field.required ? 'Select…' : 'None'}</option>${choices.map(record => `<option value="${record.id}" ${record.id === Number(value) ? 'selected' : ''}>${escape(recordLabel(record, field.target_table!))}</option>`).join('')}</select>`;
    help = `Select a record from ${target?.label ?? 'the related table'}. ${!choices.length ? 'Add a record to that table first.' : ''}`;
  } else if (field.type === 'boolean') {
    control = `<select name="${escape(name)}" ${required}><option value="">${field.required ? 'Select…' : 'Not specified'}</option><option value="true" ${value === true ? 'selected' : ''}>Yes</option><option value="false" ${value === false ? 'selected' : ''}>No</option></select>`;
  } else {
    const numeric = field.type === 'integer' || field.type === 'money';
    const type = numeric ? 'number' : field.type === 'date' ? 'date' : 'text';
    control = `<input name="${escape(name)}" type="${type}" value="${escape(value)}" ${required} ${numeric ? `step="1" ${field.min_value != null ? `min="${field.min_value}"` : ''}` : ''}>`;
    if (field.type === 'money') help = 'Whole minor units: enter 1250 for 12.50. No decimals.';
  }
  return `<label>${escape(field.label)}${field.required ? ' *' : ''}${control}${help ? `<small>${escape(help)}</small>` : ''}</label>`;
}

function setupPanel() {
  const setup = catalog?.setup;
  return `<section class="business-panel business-setup"><div class="eyebrow">${setup ? 'BUSINESS SETTINGS' : 'START WITH YOUR BUSINESS'}</div><h2>${setup ? 'Update your setup' : 'A few questions to set things up.'}</h2><p>Your answers create a workspace for your business. You can then add suppliers, customers, items, employees and orders, or create your own tables.</p><form id="setup-form"><div class="business-fields">
    ${input('business_name', 'What is your business called?', setup?.business_name, 'text', 'required maxlength="160" autocomplete="organization"')}
    ${input('business_type', 'What does your business do?', setup?.business_type, 'text', 'placeholder="For example: toy shop or furniture supplier" maxlength="200"')}
    ${input('currency', 'Which currency do you use?', setup?.currency ?? 'USD', 'text', 'required pattern="[A-Za-z]{3}" maxlength="3" placeholder="USD"')}
    <label>Do you keep physical stock?<select name="uses_inventory"><option value="true" ${setup?.uses_inventory !== false ? 'selected' : ''}>Yes</option><option value="false" ${setup?.uses_inventory === false ? 'selected' : ''}>No</option></select><small>Stock records remain available if your needs change.</small></label>
    <label class="business-span">What else should we know? <span class="business-subtle">Optional</span><textarea name="setup_notes" maxlength="4000" placeholder="For example: we sell toys in several colors and need to record an age rating.">${escape(setup?.setup_notes)}</textarea><small>Save your requirements here, then add the fields or tables you need in the workspace.</small></label>
    </div>${button(setup ? 'Save settings' : 'Create my workspace')}${setup ? ` ${button('Back to records', 'type="button" id="close-setup"', 'quiet')}` : ''}</form><hr class="business-divider"><p>Included record types</p><div class="business-setup-list">${['Suppliers','Customers','Items','Locations','Carriers','Employees','Customer orders','Order lines'].map(label => `<span>${label}</span>`).join('')}</div></section>`;
}

function recordsPanel(table: BusinessTable) {
  const all = records.get(table.slug) ?? [];
  const visible = all.filter(record => includeArchived || !record.archived);
  const fields = table.fields;
  return `<section class="business-panel"><div class="business-panel-heading"><div><h2>${escape(table.label)}</h2><p>${table.slug === 'customer_orders' ? 'Create an order, add its order lines, then submit it to purchasing.' : table.slug === 'customer_order_lines' ? 'Choose an existing order and item. Add one record for each item the customer wants.' : 'Add records below. Relationships always point to an existing record.'}</p></div><span class="business-count">${visible.length} ${visible.length === 1 ? 'record' : 'records'}</span></div>
    <div class="business-actions"><label class="business-checkbox"><input type="checkbox" id="show-archived" ${includeArchived ? 'checked' : ''}>Show archived records</label>${button('Refresh', 'type="button" id="refresh"', 'quiet small')}</div>
    ${!visible.length ? `<div class="business-empty"><strong>No ${escape(table.label.toLowerCase())} ${includeArchived ? '' : 'in use'} yet.</strong><p>Add your first record with the form below.</p></div>` : `<div class="business-table-wrap"><table class="business-table"><thead><tr><th>Record</th>${fields.map(field => `<th>${escape(field.label)}</th>`).join('')}<th>Actions</th></tr></thead><tbody>${visible.map(record => `<tr${record.archived ? ' class="archived"' : ''}><td>#${record.id}${record.archived ? '<br><span class="business-pill">Archived</span>' : ''}${status(record) ? `<br><span class="business-pill">${escape(status(record))}</span>` : ''}</td>${fields.map(field => `<td>${escape(displayValue(field, record.values[field.slug]))}</td>`).join('')}<td>${frozen(table,record) ? '<span class="business-pill">Submitted · read only</span>' : `<div class="business-actions">${button('Edit', `type="button" data-edit="${record.id}"`, 'quiet small')}${button(record.archived ? 'Restore' : 'Archive', `type="button" data-archive="${record.id}"`, 'quiet small')}${button('Delete', `type="button" data-delete="${record.id}"`, 'danger small')}${table.slug === 'customer_orders' && !record.archived ? button('Submit to purchasing', `type="button" data-submit-order="${record.id}"`, 'small') : ''}</div>`}</td></tr>`).join('')}</tbody></table></div>`}
    ${all.length >= 1000 ? '<p class="business-subtle">Showing the first 1,000 records. Larger lists need pagination; relationship selections use these loaded records.</p>' : ''}<p class="business-subtle">Delete is allowed only when no other record refers to this record. Archive keeps the history and removes the record from new selections.</p>
    ${table.slug === 'customer_orders' ? `<p>Need to add items to an order? ${button('Open order lines', 'type="button" data-table="customer_order_lines"', 'secondary small')}</p>` : ''}</section>`;
}

function editorPanel(table: BusinessTable) {
  const record = records.get(table.slug)?.find(item => item.id === editing);
  return `<section class="business-panel" id="record-editor"><div class="business-panel-heading"><div><h2>${record ? `Edit record #${record.id}` : `Add to ${escape(table.label.toLowerCase())}`}</h2><p>Fields marked * are required. Related records must exist before you can select them.</p></div>${record ? button('Cancel edit', 'type="button" id="cancel-edit"', 'quiet') : ''}</div><form id="record-form"><div class="business-fields">${table.fields.map(field => recordControl(field, record?.values[field.slug] ?? (!record && table.slug === 'customer_orders' && field.slug === 'currency' ? catalog?.setup?.currency : undefined))).join('')}</div>${button(record ? 'Save changes' : 'Add record')}</form></section>`;
}

function fieldBuilder(index: number, allowRemove: boolean) {
  return `<fieldset class="business-field-row"><legend>Field ${index}</legend><div class="business-fields">${input('label', 'Field label', '', 'text', 'required placeholder="For example: Age rating" maxlength="100"')}${input('slug', 'Field name', '', 'text', 'required pattern="[a-z][a-z0-9_]*" placeholder="age_rating" maxlength="40"')}<label>Field type<select name="type"><option value="text">Text</option><option value="integer">Whole number</option><option value="money">Money (minor units)</option><option value="boolean">Yes / no</option><option value="date">Date</option><option value="reference">Relationship to another table</option></select></label><label data-target-wrap hidden>Related table<select name="target_table"><option value="">Select a table…</option>${catalog!.tables.map(table => `<option value="${escape(table.slug)}">${escape(table.label)}</option>`).join('')}</select></label><label data-min-wrap hidden>Minimum value (optional)<input name="min_value" type="number" step="1"></label></div><div class="business-field-options"><label><input name="required" type="checkbox">Required</label><label><input name="unique" type="checkbox">Unique value</label>${allowRemove ? button('Remove field', 'type="button" data-remove-field', 'quiet small') : ''}</div></fieldset>`;
}

function customizationPanel(table: BusinessTable) {
  return `<section class="business-panel"><details class="business-details"><summary>Add a field to ${escape(table.label)}</summary><p>New fields appear in the record form immediately. If records already exist, add an optional field first.</p><form id="add-field-form"><div id="single-field">${fieldBuilder(1, false)}</div>${button('Add field')}</form></details></section><section class="business-panel"><details class="business-details" id="new-table-details"><summary>Create your own table</summary><p>For example, add vehicles or toy categories. Define its fields and relationships. The same record interface works for the new table.</p><form id="new-table-form"><div class="business-fields">${input('table_label','Table label','','text','required placeholder="For example: Vehicles" maxlength="100"')}${input('table_slug','Table name','','text','required pattern="[a-z][a-z0-9_]*" placeholder="vehicles" maxlength="40"')}</div><div id="table-fields">${fieldBuilder(1, true)}</div><div class="business-actions">${button('Add another field', 'type="button" id="add-builder-field"', 'secondary')}${button('Create table')}</div><p class="business-subtle">Use lowercase names with underscores. These names identify your table and fields.</p></form></details></section>`;
}

function render() {
  const table = currentTable();
  app.innerHTML = `<main class="business-page">${demoNavigation('business')}<header class="business-header"><div><div class="eyebrow">BUSINESS WORKSPACE</div><h1>${escape(catalog?.setup?.business_name ?? 'Make room for your business.')}</h1><p>Set up your business, keep your records together and enter customer orders.</p></div>${catalog ? `<div class="business-actions business-header-actions">${button('Business settings','type="button" id="open-setup"','quiet')}${button('Refresh','type="button" id="refresh-workspace"','quiet')}</div>` : ''}</header><div class="business-feedback${failed ? ' error' : ''}" role="status" aria-live="polite">${escape(message)}</div>
    ${!catalog ? `<section class="business-panel"><p>${loading ? 'Loading your workspace…' : 'Could not load your workspace. Start the backend and try again.'}</p>${!loading ? button('Retry', 'type="button" id="retry-load"') : ''}</section>` : !catalog.setup || showSetup ? setupPanel() : `<p class="business-note">Local business workspace · OperationsNerd integration pending</p><div class="business-layout"><aside class="business-sidebar"><nav class="business-panel business-table-nav" aria-label="Record tables"><h2>Your records</h2>${catalog.tables.map(item => `<button type="button" data-table="${escape(item.slug)}" aria-pressed="${item.slug === selected}">${escape(item.label)}<small>${(records.get(item.slug) ?? []).filter(record => !record.archived).length}</small></button>`).join('')}</nav><a class="business-button secondary" href="/purchasing.html">Open purchasing →</a></aside><div class="business-main">${table ? recordsPanel(table) + editorPanel(table) + customizationPanel(table) : '<section class="business-panel"><p>No record tables are available yet.</p></section>'}</div></div>`}</main>`;
  bind();
}

function feedback(error: unknown) {
  failed = true;
  message = error instanceof Error ? error.message : 'The request could not be completed.';
  const element = document.querySelector('.business-feedback')!;
  element.textContent = message;
  element.classList.add('error');
  element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function run(work: () => Promise<unknown>, success: string, after?: () => void) {
  if (busy) return;
  busy = true;
  completedRequests.clear();
  const progress = document.querySelector('.business-feedback')!;
  progress.textContent = 'Working…';
  progress.classList.remove('error');
  document.querySelectorAll<HTMLButtonElement>('button').forEach(item => item.disabled = true);
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea').forEach(item => item.disabled = true);
  try {
    await work();
    await refresh();
    after?.();
    completedRequests.forEach(identity => pending.delete(identity));
    message = success;
    failed = false;
    render();
  } catch (error) { feedback(error); }
  finally {
    busy = false;
    document.querySelectorAll<HTMLButtonElement>('button').forEach(item => item.disabled = false);
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea').forEach(item => item.disabled = false);
  }
}

function bindForm(id: string, work: (form: FormData) => Promise<unknown>, success: string, after?: () => void) {
  const form = document.querySelector<HTMLFormElement>(`#${id}`);
  form?.addEventListener('submit', event => {
    event.preventDefault();
    const fields = new FormData(form);
    void run(() => work(fields), success, after);
  });
}

function readRecord(form: FormData, table: BusinessTable): Values {
  const values: Values = {};
  for (const field of table.fields) {
    const text = formText(form, `record_${field.slug}`);
    if (!text) {
      if (field.required) throw new Error(`${field.label} is required.`);
      values[field.slug] = null;
    } else if (['integer','money','reference'].includes(field.type)) {
      const value = Number(text);
      if (!Number.isSafeInteger(value)) throw new Error(`${field.label} must be a whole number within the supported range.`);
      if (field.min_value != null && value < field.min_value) throw new Error(`${field.label} must be at least ${field.min_value}.`);
      values[field.slug] = value;
    } else if (field.type === 'boolean') values[field.slug] = text === 'true';
    else values[field.slug] = text;
  }
  return values;
}

function readField(row: Element): Field {
  const form = new FormData();
  row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select').forEach(control => {
    if (control instanceof HTMLInputElement && control.type === 'checkbox') {
      if (control.checked) form.set(control.name, 'true');
    } else form.set(control.name, control.value);
  });
  const type = formText(form, 'type') as FieldType;
  const min = formText(form, 'min_value');
  if ((type === 'integer' || type === 'money') && min && !Number.isSafeInteger(Number(min))) throw new Error('The minimum value must be a whole number.');
  const target = formText(form, 'target_table');
  if (type === 'reference' && !target) throw new Error('Select a related table for each relationship field.');
  return { slug: formText(form,'slug'), label: formText(form,'label'), type, required: form.has('required'), unique: form.has('unique'), ...(type === 'reference' ? { target_table: target } : {}), ...((type === 'integer' || type === 'money') && min ? { min_value: Number(min) } : {}) };
}

function bindBuilder(row: Element) {
  const type = row.querySelector<HTMLSelectElement>('[name="type"]')!;
  type.addEventListener('change', () => {
    const isReference = type.value === 'reference';
    (row.querySelector('[data-target-wrap]') as HTMLElement).hidden = !isReference;
    (row.querySelector('[name="target_table"]') as HTMLSelectElement).required = isReference;
    (row.querySelector('[data-min-wrap]') as HTMLElement).hidden = !['integer','money'].includes(type.value);
  });
  row.querySelector('[data-remove-field]')?.addEventListener('click', () => {
    if (document.querySelectorAll('#table-fields > fieldset').length === 1) { feedback(new Error('Keep at least one field in the table.')); return; }
    row.remove();
  });
  const label = row.querySelector<HTMLInputElement>('[name="label"]')!;
  const slug = row.querySelector<HTMLInputElement>('[name="slug"]')!;
  let touched = false;
  slug.addEventListener('input', () => { touched = true; });
  label.addEventListener('input', () => { if (!touched) slug.value = label.value.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''); });
}

function bind() {
  document.querySelector('#retry-load')?.addEventListener('click', () => { void loadWorkspace(); });
  document.querySelector('#refresh-workspace')?.addEventListener('click', () => { void run(async () => {}, 'Records refreshed.'); });
  document.querySelector('#open-setup')?.addEventListener('click', () => { showSetup = true; render(); });
  document.querySelector('#close-setup')?.addEventListener('click', () => { showSetup = false; render(); });
  bindForm('setup-form', form => request('/setup','POST',{ business_name: formText(form,'business_name'), currency: formText(form,'currency').toUpperCase(), business_type: optional(formText(form,'business_type')), uses_inventory: formText(form,'uses_inventory') === 'true', setup_notes: optional(formText(form,'setup_notes')) }), 'Business settings saved. Add your first records below.', () => { showSetup = false; });
  document.querySelectorAll<HTMLButtonElement>('[data-table]').forEach(item => item.addEventListener('click', () => { if (busy) return; selected = item.dataset.table!; editing = null; message = ''; failed = false; render(); }));
  document.querySelector('#show-archived')?.addEventListener('change', event => { includeArchived = (event.target as HTMLInputElement).checked; render(); });
  document.querySelector('#refresh')?.addEventListener('click', () => { void run(async () => {}, 'Records refreshed.'); });
  document.querySelector('#cancel-edit')?.addEventListener('click', () => { editing = null; render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach(item => item.addEventListener('click', () => {
    editing = Number(item.dataset.edit); render(); document.querySelector('#record-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); document.querySelector<HTMLInputElement>('#record-form input,#record-form select')?.focus({ preventScroll: true });
  }));
  bindForm('record-form', form => {
    const table = currentTable()!;
    const record = records.get(table.slug)?.find(item => item.id === editing);
    const values = readRecord(form, table);
    return request(`/tables/${encodeURIComponent(table.slug)}/records${record ? `/${record.id}` : ''}`, record ? 'PATCH' : 'POST', { values, ...(record ? { expected_version: record.version } : {}) });
  }, 'Record saved.', () => { editing = null; });
  document.querySelectorAll<HTMLButtonElement>('[data-archive]').forEach(item => item.addEventListener('click', () => {
    const record = records.get(selected)!.find(value => value.id === Number(item.dataset.archive))!;
    void run(() => request(`/tables/${encodeURIComponent(selected)}/records/${record.id}/archive`,'POST',{ archived: !record.archived, expected_version: record.version }), record.archived ? 'Record restored.' : 'Record archived.', () => { editing = null; });
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach(item => item.addEventListener('click', () => {
    const record = records.get(selected)!.find(value => value.id === Number(item.dataset.delete))!;
    if (!window.confirm(`Permanently delete ${recordLabel(record,selected)}? Referenced records cannot be deleted. You can archive them instead.`)) return;
    void run(() => request(`/tables/${encodeURIComponent(selected)}/records/${record.id}`,'DELETE',{ expected_version: record.version }), 'Record deleted.', () => { editing = null; });
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-submit-order]').forEach(item => item.addEventListener('click', () => {
    const record = records.get(selected)!.find(value => value.id === Number(item.dataset.submitOrder))!;
    if (!window.confirm('Submit this order and its lines to purchasing? After submission, the order and its lines cannot be edited.')) return;
    void run(() => request(`/orders/${record.id}/submit`,'POST',{ expected_version: record.version }), 'Customer order submitted. Its lines are now available in purchasing.', () => { editing = null; });
  }));
  document.querySelectorAll('.business-field-row').forEach(bindBuilder);
  document.querySelector('#add-builder-field')?.addEventListener('click', () => {
    const area = document.querySelector('#table-fields')!;
    area.insertAdjacentHTML('beforeend', fieldBuilder(area.children.length + 1, true));
    bindBuilder(area.lastElementChild!);
  });
  bindForm('add-field-form', () => {
    const table = currentTable()!;
    const field = readField(document.querySelector('#single-field fieldset')!);
    return request(`/tables/${encodeURIComponent(table.slug)}/fields`,'POST',{ field, expected_version: table.version });
  }, 'Field added. The record form now includes it.');
  bindForm('new-table-form', async form => {
    const slug = formText(form,'table_slug');
    const fields = [...document.querySelectorAll('#table-fields > fieldset')].map(readField);
    await request('/tables','POST',{ slug, label: formText(form,'table_label'), fields });
    selected = slug;
  }, 'Table created. You can add records now.', () => { editing = null; });
}

async function loadWorkspace() {
  loading = true;
  message = '';
  failed = false;
  render();
  try { await refresh(); }
  catch (error) {
    message = error instanceof Error ? error.message : 'Could not load your workspace.';
    failed = true;
  } finally { loading = false; render(); }
}

void loadWorkspace();
