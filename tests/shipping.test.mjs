import { describe, expect, it, vi } from 'vitest';
import { buildAfterShipRequest, buildEasyPostRequest, buildSmklogRequest, createComparisonRunner, normalizeAfterShip, normalizeEasyPost, normalizeSmklog, providerAccess, runProvider, validateParcel } from '../server/shipping.mjs';

const parcel = { product: 'One packed parcel of stationery', fromPostal: '07102', toPostal: '30303', lengthCm: 30, widthCm: 20, heightCm: 10, weightKg: 1, pickupTime: '2026-10-01T10:00', deadline: '2026-10-08', carrier: 'ups' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sampleRate = { id: 'rate_demo', carrier: 'USPS', service: 'Priority', rate: '11.01', currency: 'USD', delivery_date: '2026-10-02', est_delivery_days: 2 };

describe('shipping integration contracts (simulated, no live calls)', () => {
  it('maps one packed parcel, not the number of goods, into SMKlog', () => {
    expect(buildSmklogRequest(parcel)).toMatchObject({ quantity: 1, from_postal_code: '07102', weight_kg: 1, length_cm: 30, package_source: 'manual' });
  });

  it('converts metric package inputs to EasyPost inches and ounces', () => {
    const { shipment } = buildEasyPostRequest(parcel);
    expect(shipment.parcel.length).toBeCloseTo(11.811, 3);
    expect(shipment.parcel.weight).toBeCloseTo(35.274, 3);
    expect(shipment.from_address.zip).toBe('07102');
    expect(shipment).not.toHaveProperty('service');
    expect(shipment).not.toHaveProperty('carrier_accounts');
  });

  it('sends a local pickup time with AfterShip country and weight units', () => {
    expect(buildAfterShipRequest(parcel)).toEqual({ slug: 'ups', origin_address: { country_region: 'USA', postal_code: '07102' }, destination_address: { country_region: 'USA', postal_code: '30303' }, weight: { unit: 'kg', value: 1 }, package_count: 1, pickup_time: '2026-10-01 10:00:00' });
  });

  it.each([{ fromPostal: 'abcde' }, { weightKg: -1 }, { lengthCm: NaN }, { pickupTime: '2026-02-30T10:00' }, { pickupTime: '2026-10-01T25:00' }, { deadline: '2026-09-30' }, { carrier: 'unknown' }])('rejects invalid inputs before network access: %j', async (change) => {
    const fetcher = vi.fn();
    await expect(runProvider('smklog', { ...parcel, ...change }, { fetcher, env: { SMKLOG_ENABLED: 'true' } })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('exposes readiness without exposing secrets and requires AfterShip feature activation', () => {
    const access = providerAccess({ EASYPOST_TEST_API_KEY: 'secret-test', AFTERSHIP_API_KEY: 'secret-aftership' });
    expect(access.find((v) => v.id === 'easypost').ready).toBe(true);
    expect(access.find((v) => v.id === 'aftership').ready).toBe(false);
    expect(JSON.stringify(access)).not.toContain('secret');
  });

  it('skips blocked or unauthenticated providers rather than fabricating responses', async () => {
    const fetcher = vi.fn();
    const result = await createComparisonRunner({ fetcher })(parcel);
    expect(result.results.map((r) => r.status)).toEqual(['access_blocked', 'needs_credentials', 'needs_credentials']);
    expect(result.results.every((r) => r.traces.length === 0 && r.rates.length === 0)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not use an unanchored SMKlog delivery date to pass the planned deadline', () => {
    const [rate] = normalizeSmklog({ rates: [{ carrier: 'UPS', amount: 12.50, delivery_days: 2, delivery_estimated_date: '2026-10-02' }] }, parcel);
    expect(rate.costCents).toBe(1250);
    expect(rate.providerReportedDate).toBe('2026-10-02');
    expect(rate.deadlineAssessment).toBe('unknown');
  });

  it('distinguishes null and invalid prices from genuine zero shipping cost', () => {
    const rates = normalizeSmklog({ rates: [{ amount: null }, { amount: '' }, { amount: 'bad' }, { amount: 0 }] }, parcel);
    expect(rates.map((r) => r.costCents)).toEqual([null, null, null, 0]);
  });

  it('keeps missing dates unknown instead of adding transit days to a calendar', () => {
    const [rate] = normalizeEasyPost({ rates: [sampleRate] }, null, parcel);
    expect(rate.transitDays).toBe(2);
    expect(rate.deliveryDate).toBeNull();
    expect(rate.deadlineAssessment).toBe('unknown');
  });

  it('uses only a SmartRate prediction anchored to the requested pickup date', () => {
    const prediction = { rates: [{ rate: { id: 'rate_demo' }, easypost_time_in_transit_data: { planned_ship_date: '2026-10-01', easypost_estimated_delivery_date: '2026-10-08' } }] };
    expect(normalizeEasyPost({ rates: [sampleRate] }, prediction, parcel)[0].deadlineAssessment).toBe('estimated_on_time');
    prediction.rates[0].easypost_time_in_transit_data.planned_ship_date = '2026-10-02';
    expect(normalizeEasyPost({ rates: [sampleRate] }, prediction, parcel)[0].deadlineAssessment).toBe('unknown');
  });

  it.each([
    ['2026-10-02', '2026-10-08', 'estimated_on_time'],
    ['2026-10-02', '2026-10-09', 'uncertain'],
    ['2026-10-09', '2026-10-11', 'estimated_late'],
    ['2026-10-09', '2026-10-02', 'unknown'],
  ])('evaluates the full AfterShip estimate window: %s–%s', (min, max, expected) => {
    const [rate] = normalizeAfterShip({ data: { estimated_delivery_date: '2026-10-04', estimated_delivery_date_min: min, estimated_delivery_date_max: max } }, parcel);
    expect(rate.deadlineAssessment).toBe(expected);
    expect(rate.costCents).toBeNull();
    expect(rate.guaranteed).toBe(false);
  });

  it('records HTTP 403 and blocks repeated calls across different parcels', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ error_code: 1010 }, 403));
    const run = createComparisonRunner({ fetcher, env: { SMKLOG_ENABLED: 'true' } });
    const first = await run(parcel, ['smklog']);
    expect(first.results[0].status).toBe('access_denied');
    expect(first.results[0].traces[0].httpStatus).toBe(403);
    expect((await run({ ...parcel, toPostal: '10001' }, ['smklog'])).results[0].status).toBe('access_blocked');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('caches identical requests instead of polling the public provider', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ mode: 'parcel_label_ready', rates: [{ carrier: 'UPS', service: 'Ground', amount: 10 }] }));
    const run = createComparisonRunner({ fetcher, env: { SMKLOG_ENABLED: 'true' } });
    expect((await run(parcel, ['smklog'])).results[0].cached).toBe(false);
    expect((await run(parcel, ['smklog'])).results[0].cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('recognizes timeouts without leaking provider exceptions or credentials', async () => {
    const fetcher = vi.fn().mockRejectedValue(new DOMException('secret-token', 'TimeoutError'));
    const result = await runProvider('aftership', parcel, { fetcher, env: { AFTERSHIP_API_KEY: 'secret-token', AFTERSHIP_EDD_ENABLED: 'true' } });
    expect(result.status).toBe('timeout');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('retains EasyPost rates when prediction access fails and never buys labels', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ id: 'shp_demo', mode: 'test', rates: [sampleRate] })).mockResolvedValueOnce(json({}, 403));
    const result = await runProvider('easypost', parcel, { fetcher, env: { EASYPOST_TEST_API_KEY: 'test-secret' } });
    expect(result.status).toBe('ok');
    expect(result.mode).toBe('test');
    expect(result.rates[0].deadlineAssessment).toBe('unknown');
    expect(result.notices.join(' ')).toContain('SmartRate');
    expect(fetcher.mock.calls.every(([url]) => !url.includes('/buy'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });

  it('rejects a production-mode response in the EasyPost test integration', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ id: 'shp_demo', mode: 'production', rates: [sampleRate] }));
    const result = await runProvider('easypost', parcel, { fetcher, env: { EASYPOST_TEST_API_KEY: 'wrong-mode' } });
    expect(result.status).toBe('wrong_key_mode');
    expect(result.rates).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses the official AfterShip endpoint and response shape', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ meta: { code: 200 }, data: { slug: 'ups', estimated_delivery_date: '2026-10-04', estimated_delivery_date_min: '2026-10-03', estimated_delivery_date_max: '2026-10-06' } }));
    const result = await runProvider('aftership', parcel, { fetcher, env: { AFTERSHIP_API_KEY: 'test-secret', AFTERSHIP_EDD_ENABLED: 'true' } });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.aftership.com/tracking/2026-07/estimated-delivery-date/predict');
    expect(result.status).toBe('ok');
    expect(result.rates[0].deadlineAssessment).toBe('estimated_on_time');
  });

  it('does not count an empty AfterShip prediction as a successful integration result', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ data: {} }));
    const result = await runProvider('aftership', parcel, { fetcher, env: { AFTERSHIP_API_KEY: 'test-secret', AFTERSHIP_EDD_ENABLED: 'true' } });
    expect(result.status).toBe('incomplete_data');
    expect(result.rates[0].deadlineAssessment).toBe('unknown');
  });

  it('can run newly configured providers without a stale missing-key cache', async () => {
    const env = {};
    const fetcher = vi.fn().mockResolvedValue(json({ id: 'shp_demo', mode: 'test', rates: [] }));
    const run = createComparisonRunner({ fetcher, env });
    expect((await run(parcel, ['easypost'])).results[0].status).toBe('needs_credentials');
    env.EASYPOST_TEST_API_KEY = 'new-test-key';
    expect((await run(parcel, ['easypost'])).results[0].status).toBe('no_rates');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects provider selection errors without any calls', async () => {
    const fetcher = vi.fn();
    const run = createComparisonRunner({ fetcher });
    await expect(run(parcel, ['unknown'])).rejects.toThrow('providers');
    await expect(run(parcel, ['smklog', 'smklog'])).rejects.toThrow('providers');
    expect(fetcher).not.toHaveBeenCalled();
    expect(validateParcel(parcel).fromPostal).toBe('07102');
  });
});
