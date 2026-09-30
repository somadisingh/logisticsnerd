// Server-only adapters. Secrets and raw authenticated responses never reach the browser.
export const providers = ['smklog', 'easypost', 'aftership'];
const names = { smklog: 'SMKlog', easypost: 'EasyPost', aftership: 'AfterShip' };
const docs = {
  smklog: 'https://smklog.com/api',
  easypost: 'https://docs.easypost.com/docs/shipments',
  aftership: 'https://www.aftership.com/docs/tracking/1o2zu0jrca785-prediction-for-the-estimated-delivery-date',
};

export function validateParcel(input) {
  if (!input || typeof input !== 'object') throw new Error('Enter a parcel request.');
  const value = {};
  for (const field of ['product', 'fromPostal', 'toPostal', 'pickupTime', 'deadline', 'carrier']) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 160) throw new Error(`Enter a valid ${field}.`);
    value[field] = input[field].trim();
  }
  if (![value.fromPostal, value.toPostal].every((zip) => /^\d{5}$/.test(zip))) throw new Error('This comparison uses five-digit US ZIP codes.');
  const day = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value.pickupTime) || !day(value.pickupTime.slice(0, 10)) || Number(value.pickupTime.slice(11, 13)) > 23 || Number(value.pickupTime.slice(14, 16)) > 59) throw new Error('Enter a valid local pickup date and time.');
  if (!day(value.deadline) || value.deadline < value.pickupTime.slice(0, 10)) throw new Error('The deadline must be on or after pickup.');
  if (!['ups', 'usps', 'fedex'].includes(value.carrier)) throw new Error('Choose UPS, USPS, or FedEx for AfterShip.');
  for (const field of ['lengthCm', 'widthCm', 'heightCm', 'weightKg']) {
    if (typeof input[field] !== 'number' || !Number.isFinite(input[field]) || input[field] <= 0 || input[field] > 10000) throw new Error(`Enter a positive ${field}.`);
    value[field] = input[field];
  }
  for (const field of ['fromStreet', 'toStreet', 'service']) {
    if (input[field] != null && (typeof input[field] !== 'string' || input[field].length > 160)) throw new Error(`Enter a valid ${field}.`);
    value[field] = input[field]?.trim() ?? '';
  }
  return value;
}

export function providerAccess(env = {}) {
  return providers.map((id) => {
    let ready = true;
    let detail = 'Public quote endpoint; one call per distinct parcel, cached locally.';
    if (id === 'smklog' && env.SMKLOG_ENABLED !== 'true') {
      ready = false;
      detail = 'Access needed. The initial live probe returned Cloudflare HTTP 403 / error 1010. Enable only after access is restored.';
    }
    if (id === 'easypost' && !env.EASYPOST_TEST_API_KEY?.trim()) {
      ready = false;
      detail = 'Needs EASYPOST_TEST_API_KEY in .env.local.';
    }
    if (id === 'aftership' && (!env.AFTERSHIP_API_KEY?.trim() || env.AFTERSHIP_EDD_ENABLED !== 'true')) {
      ready = false;
      detail = 'Needs AFTERSHIP_API_KEY and delivery prediction activation; set AFTERSHIP_EDD_ENABLED=true after activation.';
    }
    return { id, name: names[id], ready, detail, docs: docs[id] };
  });
}

export function buildSmklogRequest(p) {
  return { product: p.product, quantity: 1, from_postal_code: p.fromPostal, to_postal_code: p.toPostal, to_country_code: 'US', length_cm: p.lengthCm, width_cm: p.widthCm, height_cm: p.heightCm, weight_kg: p.weightKg, package_source: 'manual' };
}

export function buildEasyPostRequest(p) {
  const address = (postal, street) => ({ zip: postal, country: 'US', ...(street ? { street1: street } : {}) });
  return { shipment: { from_address: address(p.fromPostal, p.fromStreet), to_address: address(p.toPostal, p.toStreet), parcel: { length: p.lengthCm / 2.54, width: p.widthCm / 2.54, height: p.heightCm / 2.54, weight: p.weightKg * 35.27396195 } } };
}

export function buildAfterShipRequest(p) {
  return { slug: p.carrier, ...(p.service ? { service_type_name: p.service } : {}), origin_address: { country_region: 'USA', postal_code: p.fromPostal }, destination_address: { country_region: 'USA', postal_code: p.toPostal }, weight: { unit: 'kg', value: p.weightKg }, package_count: 1, pickup_time: p.pickupTime.replace('T', ' ') + ':00' };
}

function isoDate(value) {
  if (typeof value !== 'string') return null;
  const date = value.slice(0, 10);
  const parsed = Date.parse(`${date}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date ? date : null;
}

function cents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (!/^\d+(\.\d+)?$/.test(String(value)) || !Number.isFinite(Number(value)) || Number(value) < 0) return null;
  const result = Math.round(Number(value) * 100);
  return Number.isSafeInteger(result) ? result : null;
}

function rate(value, deadline) {
  const min = value.earliestDate;
  const max = value.latestDate;
  let deadlineAssessment = 'unknown';
  if (min && max && min > max) return { ...value, deadlineAssessment };
  if (max) deadlineAssessment = max <= deadline ? 'estimated_on_time' : min && min > deadline ? 'estimated_late' : 'uncertain';
  else if (value.deliveryDate) deadlineAssessment = value.deliveryDate <= deadline ? 'estimated_on_time' : 'estimated_late';
  return { ...value, deadlineAssessment };
}

export function normalizeSmklog(body, p) {
  if (!Array.isArray(body?.rates)) throw new Error('SMKlog returned an unrecognized response.');
  return body.rates.map((r) => rate({ carrier: String(r.carrier ?? 'Unknown'), service: String(r.service ?? 'Unspecified'), costCents: cents(r.amount), currency: typeof r.currency === 'string' ? r.currency : 'USD', deliveryDate: null, earliestDate: null, latestDate: null, transitDays: Number.isFinite(r.delivery_days) ? r.delivery_days : null, deliveryWindow: typeof r.delivery_window === 'string' ? r.delivery_window : null, guaranteed: false, providerReportedDate: isoDate(r.delivery_estimated_date) }, p.deadline));
}

export function normalizeEasyPost(body, prediction, p) {
  if (!Array.isArray(body?.rates)) throw new Error('EasyPost returned an unrecognized shipment response.');
  return body.rates.map((r) => {
    const entry = prediction?.rates?.find((v) => v.rate?.id === r.id);
    const date = entry?.easypost_time_in_transit_data?.planned_ship_date === p.pickupTime.slice(0, 10)
      ? isoDate(entry.easypost_time_in_transit_data.easypost_estimated_delivery_date) : null;
    return rate({ carrier: String(r.carrier ?? 'Unknown'), service: String(r.service ?? 'Unspecified'), costCents: cents(r.rate), currency: typeof r.currency === 'string' ? r.currency : null, deliveryDate: date, earliestDate: null, latestDate: null, transitDays: Number.isFinite(r.est_delivery_days) ? r.est_delivery_days : null, deliveryWindow: null, guaranteed: false, providerReportedDate: isoDate(r.delivery_date) }, p.deadline);
  });
}

export function normalizeAfterShip(body, p) {
  if (!body?.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new Error('AfterShip returned an unrecognized prediction response.');
  const d = body.data;
  return [rate({ carrier: String(d.slug ?? p.carrier), service: String(d.service_type_name ?? (p.service || 'Carrier prediction')), costCents: null, currency: null, deliveryDate: isoDate(d.estimated_delivery_date), earliestDate: isoDate(d.estimated_delivery_date_min), latestDate: isoDate(d.estimated_delivery_date_max), transitDays: null, deliveryWindow: null, guaranteed: false, confidenceCode: d.confidence_code ?? null }, p.deadline)];
}

class ProviderError extends Error {
  constructor(status, httpStatus) { super(status); this.status = status; this.httpStatus = httpStatus; }
}

async function requestJson(fetcher, url, options, traces) {
  const started = performance.now();
  const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
  traces.push({ endpoint: url, httpStatus: response.status, durationMs: Math.round(performance.now() - started) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderError(response.status === 401 ? 'authentication_failed' : response.status === 403 ? 'access_denied' : response.status === 429 ? 'rate_limited' : 'provider_error', response.status);
  }
  const body = await response.json();
  if (body?.meta?.code && body.meta.code !== 200) throw new ProviderError('provider_error', response.status);
  return body;
}

export async function runProvider(id, input, { env = {}, fetcher = fetch, now = () => new Date() } = {}) {
  if (!providers.includes(id)) throw new Error('Unknown shipping provider.');
  const p = validateParcel(input);
  const access = providerAccess(env).find((v) => v.id === id);
  const result = { provider: id, name: names[id], status: 'pending', mode: id === 'easypost' ? 'test' : 'live', checkedAt: now().toISOString(), durationMs: 0, traces: [], rates: [], notices: [] };
  if (!access.ready) return { ...result, status: id === 'smklog' ? 'access_blocked' : 'needs_credentials', notices: [access.detail] };
  const started = performance.now();
  const post = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    if (id === 'smklog') {
      const body = await requestJson(fetcher, 'https://quote-api.smklog.com/quote', post(buildSmklogRequest(p)), result.traces);
      result.providerMode = typeof body.mode === 'string' ? body.mode : null;
      result.rates = normalizeSmklog(body, p);
      result.notices.push('Shipping cost only. This endpoint does not accept our planned pickup date; reported dates are shown separately and do not determine deadline suitability.');
    } else if (id === 'easypost') {
      const headers = { Authorization: `Basic ${Buffer.from(`${env.EASYPOST_TEST_API_KEY.trim()}:`).toString('base64')}` };
      const body = await requestJson(fetcher, 'https://api.easypost.com/v2/shipments', post(buildEasyPostRequest(p), headers), result.traces);
      result.mode = body.mode === 'test' ? 'test' : 'unverified';
      if (body.mode !== 'test') throw new ProviderError('wrong_key_mode', 200);
      let prediction = null;
      if (body.rates?.length && typeof body.id === 'string' && /^shp_[A-Za-z0-9]+$/.test(body.id)) {
        try {
          prediction = await requestJson(fetcher, `https://api.easypost.com/v2/shipments/${body.id}/smartrate/delivery_date?planned_ship_date=${p.pickupTime.slice(0, 10)}`, { method: 'GET', headers }, result.traces);
        } catch {
          result.notices.push('Rates returned, but SmartRate delivery prediction was unavailable. Deadline suitability remains unknown where no planned-date prediction was returned.');
        }
      }
      result.rates = normalizeEasyPost(body, prediction, p);
      result.notices.push('EasyPost test mode validates integration behavior; its sample rates and dates cannot establish live price or prediction accuracy. Missing street addresses can limit carrier coverage.');
      if (body.messages?.length) result.notices.push('One or more carriers reported a rating issue; inspect account setup and address completeness.');
    } else {
      const body = await requestJson(fetcher, 'https://api.aftership.com/tracking/2026-07/estimated-delivery-date/predict', post(buildAfterShipRequest(p), { 'as-api-key': env.AFTERSHIP_API_KEY.trim() }), result.traces);
      result.rates = normalizeAfterShip(body, p);
      result.notices.push('Delivery prediction for the chosen carrier; no shipping price. Pickup time is interpreted in the origin location’s local time.');
    }
    result.status = result.rates.length ? result.rates.some((r) => r.costCents !== null || r.deliveryDate || r.earliestDate || r.latestDate || r.transitDays !== null || r.deliveryWindow) ? 'ok' : 'incomplete_data' : 'no_rates';
    if (result.status === 'incomplete_data') result.notices.push('The response supplied no usable price or delivery information.');
    if (result.status === 'no_rates') result.notices.push('The provider supplied no rate options. This does not establish that a supplier cannot deliver.');
  } catch (error) {
    result.status = error instanceof ProviderError ? error.status : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : error instanceof SyntaxError ? 'invalid_response' : 'request_failed';
    result.notices.push(error instanceof ProviderError ? `Provider request returned HTTP ${error.httpStatus}. Check access, credentials, or plan entitlements. No automatic retry was made.` : 'The request could not be completed or its response did not match the documented format.');
  }
  result.durationMs = Math.round(performance.now() - started);
  return result;
}

export function createComparisonRunner(options = {}) {
  const cache = new Map();
  const blocked = new Set();
  let config = '';
  return async (input, selected = providers) => {
    const p = validateParcel(input);
    if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some((id) => !providers.includes(id))) throw new Error('Select valid providers.');
    const env = options.env ?? {};
    const currentConfig = JSON.stringify([env.SMKLOG_ENABLED, env.EASYPOST_TEST_API_KEY, env.AFTERSHIP_API_KEY, env.AFTERSHIP_EDD_ENABLED]);
    if (config !== currentConfig) { cache.clear(); blocked.clear(); config = currentConfig; }
    const results = [];
    for (const id of selected) {
      const key = JSON.stringify([id, p]);
      const prior = cache.get(key);
      if (prior && Date.now() - prior.time < 10 * 60 * 1000) {
        results.push({ ...await prior.promise, cached: true });
        continue;
      }
      if (blocked.has(id)) {
        results.push({ provider: id, name: names[id], status: 'access_blocked', mode: id === 'easypost' ? 'test' : 'live', checkedAt: new Date().toISOString(), durationMs: 0, traces: [], rates: [], notices: ['Access was denied earlier in this server session. Further calls are disabled; restore provider access before restarting.'], cached: false });
        continue;
      }
      const promise = runProvider(id, p, options).then((result) => {
        if (['access_denied', 'rate_limited'].includes(result.status)) blocked.add(id);
        if (!result.traces.length) cache.delete(key);
        return result;
      });
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, { time: Date.now(), promise });
      results.push({ ...await promise, cached: false });
    }
    return { checkedAt: new Date().toISOString(), parcel: p, results };
  };
}
