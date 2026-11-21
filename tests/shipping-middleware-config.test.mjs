import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shippingMiddleware } from '../server/middleware.mjs';

const parcel = { product: 'boxes', fromPostal: '10001', toPostal: '10002', pickupTime: '2026-11-22T10:00', deadline: '2026-11-30', carrier: 'ups', lengthCm: 20, widthCm: 15, heightCm: 10, weightKg: 1 };
const configs = {
  aftership: { AFTERSHIP_API_KEY: 'offline-prediction-key', AFTERSHIP_EDD_ENABLED: 'true' },
  easypost: { EASYPOST_TEST_API_KEY: 'offline-test-key' },
  smklog: { SMKLOG_ENABLED: 'true' },
};
function response(url) {
  if (url.includes('aftership')) return new Response(JSON.stringify({ data: { estimated_delivery_date: '2026-11-25' } }));
  if (url.includes('easypost')) return new Response(JSON.stringify({ mode: 'test', rates: [{ id: 'rate', rate: '4.00' }] }));
  return new Response(JSON.stringify({ rates: [{ amount: '4.00' }] }));
}
const servers = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});
async function app(env) {
  const getEnv = typeof env === 'function' ? env : () => env;
  const middleware = shippingMiddleware(getEnv);
  const server = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return (provider, product = 'boxes') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/shipping/compare', headers: { 'Content-Type': 'application/json', Connection: 'close' } }, (res) => {
      let data = '';
      res.setEncoding('utf8'); res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ parcel: { ...parcel, product }, providers: [provider] }));
  });
}

describe('real HTTP shipping middleware env Proxy', () => {
  for (const provider of ['aftership', 'easypost', 'smklog']) {
    it(`reads ${provider} settings through the middleware get-only Proxy`, async () => {
      const fetcher = vi.fn(async (url) => response(url));
      vi.stubGlobal('fetch', fetcher);
      const request = await app({ ...configs[provider] });
      const value = await request(provider);
      expect(value.status).toBe(200);
      expect(value.results[0].status).toBe('ok');
      expect(fetcher).toHaveBeenCalledTimes(1);
      if (provider === 'aftership') expect(fetcher.mock.calls[0][1].headers['as-api-key']).toBe('offline-prediction-key');
      if (provider === 'easypost') expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from('offline-test-key:').toString('base64')}`);
    });
  }

  for (const [provider, field] of [['aftership', 'AFTERSHIP_API_KEY'], ['easypost', 'EASYPOST_TEST_API_KEY']]) {
    it(`a later HTTP request reads updated ${provider} credentials`, async () => {
      const env = { ...configs[provider] };
      const fetcher = vi.fn(async (url) => response(url));
      vi.stubGlobal('fetch', fetcher);
      const request = await app(env);
      await request(provider);
      env[field] = 'replacement-offline-key';
      const value = await request(provider);
      expect(value.results[0].status).toBe('ok');
      expect(value.results[0].cached).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(2);
      const headers = fetcher.mock.calls[1][1].headers;
      if (provider === 'aftership') expect(headers['as-api-key']).toBe('replacement-offline-key');
      else expect(headers.Authorization).toBe(`Basic ${Buffer.from('replacement-offline-key:').toString('base64')}`);
    });
  }

  for (const [provider, field] of [['smklog', 'SMKLOG_ENABLED'], ['aftership', 'AFTERSHIP_EDD_ENABLED']]) {
    it(`does not use cached ready ${provider} results after deactivation`, async () => {
      const env = { ...configs[provider] };
      const fetcher = vi.fn(async (url) => response(url));
      vi.stubGlobal('fetch', fetcher);
      const request = await app(env);
      expect((await request(provider)).results[0].status).toBe('ok');
      env[field] = 'false';
      expect((await request(provider)).results[0].status).toBe(provider === 'smklog' ? 'access_blocked' : 'needs_credentials');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  }

  for (const provider of ['easypost', 'aftership']) {
    it(`missing ${provider} credentials never trigger a provider request`, async () => {
      const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
      const request = await app({});
      expect((await request(provider)).results[0].status).toBe('needs_credentials');
      expect(fetcher).not.toHaveBeenCalled();
    });
  }

  it('retains same-config cache reuse across real HTTP requests', async () => {
    const fetcher = vi.fn(async (url) => response(url)); vi.stubGlobal('fetch', fetcher);
    const request = await app({ ...configs.aftership });
    expect((await request('aftership')).results[0].cached).toBe(false);
    expect((await request('aftership')).results[0].cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retains same-config denial suppression across real HTTP requests', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 403 })); vi.stubGlobal('fetch', fetcher);
    const request = await app({ ...configs.aftership });
    expect((await request('aftership')).results[0].status).toBe('access_denied');
    expect((await request('aftership', 'paper')).results[0].status).toBe('access_blocked');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads only the supported snapshot settings from a fresh environment getter', async () => {
    const fields = [];
    const env = new Proxy({}, { get: (_, key) => { fields.push(key); if (!(key in configs.aftership) && !['SMKLOG_ENABLED', 'EASYPOST_TEST_API_KEY'].includes(key)) throw new Error('unexpected setting'); return configs.aftership[key]; } });
    const fetcher = vi.fn(async (url) => response(url)); vi.stubGlobal('fetch', fetcher);
    const request = await app(() => env);
    expect((await request('aftership')).results[0].status).toBe('ok');
    expect(fields).toEqual(['SMKLOG_ENABLED', 'EASYPOST_TEST_API_KEY', 'AFTERSHIP_API_KEY', 'AFTERSHIP_EDD_ENABLED']);
  });
});
