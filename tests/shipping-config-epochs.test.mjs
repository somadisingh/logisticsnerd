import { describe, expect, it, vi } from 'vitest';
import { createComparisonRunner } from '../server/shipping.mjs';

const parcel = {
  product: 'boxes', fromPostal: '10001', toPostal: '10002',
  pickupTime: '2026-11-22T10:00', deadline: '2026-11-30', carrier: 'ups',
  lengthCm: 20, widthCm: 15, heightCm: 10, weightKg: 1,
};
const otherParcel = { ...parcel, product: 'paper' };
const success = (provider) => provider === 'aftership'
  ? new Response(JSON.stringify({ data: { estimated_delivery_date: '2026-11-25' } }))
  : provider === 'easypost'
    ? new Response(JSON.stringify({ mode: 'test', rates: [{ id: 'rate', carrier: 'UPS', rate: '4.00' }] }))
    : new Response(JSON.stringify({ rates: [{ carrier: 'UPS', amount: '4.00' }] }));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(provider, first) {
  const env = { SMKLOG_ENABLED: 'true', EASYPOST_TEST_API_KEY: 'old-test-key', AFTERSHIP_API_KEY: 'old-prediction-key', AFTERSHIP_EDD_ENABLED: 'true' };
  const fetcher = vi.fn().mockImplementationOnce(() => first.promise).mockImplementation(async () => success(provider));
  return { env, fetcher, run: createComparisonRunner({ env, fetcher }) };
}
function rotate(env, provider) {
  if (provider === 'aftership') env.AFTERSHIP_API_KEY = 'new-prediction-key';
  else if (provider === 'easypost') env.EASYPOST_TEST_API_KEY = 'new-test-key';
  else env.SMKLOG_ENABLED = 'changed-configuration';
}

describe('shipping configuration epochs', () => {
  for (const provider of ['aftership', 'easypost']) {
    for (const status of [403, 429]) {
      it(`old ${provider} HTTP ${status} cannot block the replacement config`, async () => {
        const first = deferred();
        const { env, fetcher, run } = fixture(provider, first);
        const old = run(parcel, [provider]);
        rotate(env, provider);
        expect((await run(parcel, [provider])).results[0].status).toBe('ok');
        first.resolve(new Response('{}', { status }));
        expect((await old).results[0].status).toBe(status === 403 ? 'access_denied' : 'rate_limited');
        // Different parcel bypasses the successful cache entry and exposes the
        // provider-wide poison that a same-parcel cache hit would conceal.
        expect((await run(otherParcel, [provider])).results[0].status).toBe('ok');
        expect(fetcher).toHaveBeenCalledTimes(3);
      });
    }
    it(`old ${provider} transport failure cannot evict the replacement result`, async () => {
      const first = deferred();
      const { env, fetcher, run } = fixture(provider, first);
      const old = run(parcel, [provider]);
      rotate(env, provider);
      await run(parcel, [provider]);
      first.reject(new TypeError('simulated network failure'));
      expect((await old).results[0].status).toBe('request_failed');
      expect((await run(parcel, [provider])).results[0].cached).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  }

  for (const mutation of ['key', 'activation', 'key-removal']) {
    it(`one comparison keeps its initial AfterShip ${mutation} after awaiting another provider`, async () => {
      const first = deferred();
      const env = { SMKLOG_ENABLED: 'true', AFTERSHIP_API_KEY: 'original-key', AFTERSHIP_EDD_ENABLED: 'true' };
      const fetcher = vi.fn().mockImplementationOnce(() => first.promise).mockImplementation(async () => success('aftership'));
      const run = createComparisonRunner({ env, fetcher });
      const pending = run(parcel, ['smklog', 'aftership']);
      if (mutation === 'key') env.AFTERSHIP_API_KEY = 'replacement-key';
      if (mutation === 'activation') env.AFTERSHIP_EDD_ENABLED = 'false';
      if (mutation === 'key-removal') delete env.AFTERSHIP_API_KEY;
      first.resolve(success('smklog'));
      const result = await pending;
      expect(result.results.map((r) => r.status)).toEqual(['ok', 'ok']);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[1][1].headers['as-api-key']).toBe('original-key');
    });
  }

  it('an in-flight comparison does not activate a provider enabled only after it started', async () => {
    const first = deferred();
    const env = { SMKLOG_ENABLED: 'true', AFTERSHIP_API_KEY: 'key', AFTERSHIP_EDD_ENABLED: 'false' };
    const fetcher = vi.fn(() => first.promise);
    const run = createComparisonRunner({ env, fetcher });
    const pending = run(parcel, ['smklog', 'aftership']);
    env.AFTERSHIP_EDD_ENABLED = 'true';
    first.resolve(success('smklog'));
    expect((await pending).results[1].status).toBe('needs_credentials');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('captures EasyPost credentials before the comparison awaits its first provider', async () => {
    const first = deferred();
    const env = { SMKLOG_ENABLED: 'true', EASYPOST_TEST_API_KEY: 'initial-test-key' };
    const fetcher = vi.fn().mockImplementationOnce(() => first.promise).mockImplementation(async () => success('easypost'));
    const run = createComparisonRunner({ env, fetcher });
    const pending = run(parcel, ['smklog', 'easypost']);
    env.EASYPOST_TEST_API_KEY = 'replacement-test-key';
    first.resolve(success('smklog'));
    expect((await pending).results[1].status).toBe('ok');
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe(`Basic ${Buffer.from('initial-test-key:').toString('base64')}`);
  });

  it('retains denial suppression within one unchanged config', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 403 }));
    const run = createComparisonRunner({ env: { AFTERSHIP_API_KEY: 'key', AFTERSHIP_EDD_ENABLED: 'true' }, fetcher });
    expect((await run(parcel, ['aftership'])).results[0].status).toBe('access_denied');
    expect((await run(otherParcel, ['aftership'])).results[0].status).toBe('access_blocked');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares an unchanged-config pending request instead of adding carrier calls', async () => {
    const first = deferred();
    const { run, fetcher } = fixture('aftership', first);
    const a = run(parcel, ['aftership']);
    const b = run(parcel, ['aftership']);
    first.resolve(success('aftership'));
    expect((await a).results[0].cached).toBe(false);
    expect((await b).results[0].cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('treats A-B-A as three epochs, so late first-A denial cannot poison current A', async () => {
    const first = deferred();
    const { env, run, fetcher } = fixture('aftership', first);
    const originalKey = env.AFTERSHIP_API_KEY;
    const old = run(parcel, ['aftership']);
    rotate(env, 'aftership');
    await run(parcel, ['aftership']);
    env.AFTERSHIP_API_KEY = originalKey;
    await run(parcel, ['aftership']);
    first.resolve(new Response('{}', { status: 403 }));
    await old;
    expect((await run(otherParcel, ['aftership'])).results[0].status).toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('old trace-free completion cannot evict a newer request after same-epoch TTL expiry', async () => {
    const first = deferred();
    const { run, fetcher } = fixture('aftership', first);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000000);
    try {
      const old = run(parcel, ['aftership']);
      clock.mockReturnValue(1000000 + 10 * 60 * 1000);
      await run(parcel, ['aftership']);
      first.reject(new TypeError('simulated transport failure'));
      await old;
      expect((await run(parcel, ['aftership'])).results[0].cached).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });
});
