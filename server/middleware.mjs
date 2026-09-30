import { createComparisonRunner, providerAccess } from './shipping.mjs';

export function shippingMiddleware(getEnv) {
  const fetcher = (...args) => fetch(...args);
  // Read credentials afresh so a .env.local update works without exposing them.
  const run = createComparisonRunner({ fetcher, env: new Proxy({}, { get: (_, key) => getEnv()[key] }) });
  let active = false;
  return async (req, res, next) => {
    const path = req.url?.split('?')[0];
    if (!['/api/shipping/status', '/api/shipping/compare'].includes(path)) return next();
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    if (path === '/api/shipping/status' && req.method === 'GET') return send(200, { providers: providerAccess(getEnv()) });
    if (path !== '/api/shipping/compare' || req.method !== 'POST') return send(405, { error: 'Use POST to compare shipping providers.' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: 'Use the local comparison page.' });
    if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Send a JSON parcel request.' });
    if (active) return send(429, { error: 'A comparison is already running. Wait for it to finish.' });
    active = true;
    try {
      let content = '';
      for await (const chunk of req) {
        content += chunk;
        if (content.length > 16384) return send(413, { error: 'The parcel request is too large.' });
      }
      let body;
      try { body = JSON.parse(content); } catch { return send(400, { error: 'Send a valid JSON parcel request.' }); }
      const result = await run(body.parcel, body.providers);
      send(200, result);
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : 'Check the parcel request.' });
    } finally { active = false; }
  };
}
