import { createComparisonRunner, providerAccess } from './shipping.mjs';
import { requestOriginAllowed } from './request-origin.mjs';
import { readBody, sendBodyFailure } from './read-body.mjs';

export function shippingMiddleware(getEnv, { bodyIdleMs } = {}) {
  const fetcher = (...args) => fetch(...args);
  // Read credentials afresh so a .env.local update works without exposing them.
  const run = createComparisonRunner({ fetcher, env: new Proxy({}, { get: (_, key) => getEnv()[key] }) });
  let active = false;
  return async (req, res, next) => {
    const path = req.url?.split('?')[0];
    if (!['/api/shipping/status', '/api/shipping/compare'].includes(path)) return next();
    const send = (status, data, headers) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(data));
    };
    if (path === '/api/shipping/status' && req.method === 'GET') return send(200, { providers: providerAccess(getEnv()) });
    if (path !== '/api/shipping/compare' || req.method !== 'POST') return send(405, { error: 'Use POST to compare shipping providers.' });
    if (!requestOriginAllowed(req, getEnv())) return send(403, { error: 'Use the application comparison page.' });
    if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Send a JSON parcel request.' });
    if (active) return send(429, { error: 'A comparison is already running. Wait for it to finish.' });
    active = true;
    try {
      const read = await readBody(req, { idleMs: bodyIdleMs });
      if (read.error) return sendBodyFailure(send, read.error, 'parcel');
      let body;
      try { body = JSON.parse(read.text); } catch { return send(400, { error: 'Send a valid JSON parcel request.' }); }
      const result = await run(body.parcel, body.providers);
      send(200, result);
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : 'Check the parcel request.' });
    } finally { active = false; }
  };
}
