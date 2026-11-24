import { createEstimateRunner, estimateAccess, EstimateError } from './procurement.mjs';
import { CacheError, createRedisCache } from './redis-cache.mjs';
import { requestOriginAllowed } from './request-origin.mjs';
import { readBody, sendBodyFailure } from './read-body.mjs';

export function procurementMiddleware(getEnv, rules, catalog, { bodyIdleMs } = {}) {
  const cache = createRedisCache({ getEnv });
  const run = createEstimateRunner({ env: getEnv, rules, catalog, persistentCache: cache });
  const middleware = async (req, res, next) => {
    const path = req.url?.split('?')[0];
    if (!['/api/procurement/status', '/api/procurement/estimates'].includes(path)) return next();
    const send = (status, data, headers) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(data));
    };
    if (path === '/api/procurement/status' && req.method === 'GET') {
      const modelConfigured = estimateAccess(getEnv()).configured;
      const cacheConfigured = cache.configured();
      return send(200, { configured: modelConfigured && cacheConfigured, modelConfigured, cacheConfigured, cache: { type: 'redis', ttlDays: 7 } });
    }
    if (path !== '/api/procurement/estimates' || req.method !== 'POST') return send(405, { error: 'Use POST to generate estimates.' });
    if (!requestOriginAllowed(req, getEnv())) return send(403, { error: 'Use the application procurement page.' });
    if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Send a JSON procurement request.' });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once('close', cancel);
    try {
      const read = await readBody(req, { idleMs: bodyIdleMs });
      if (read.error) return sendBodyFailure(send, read.error, 'procurement');
      let body;
      try { body = JSON.parse(read.text); } catch { return send(400, { error: 'Send a valid JSON procurement request.' }); }
      send(200, await run(body, { signal: controller.signal }));
    } catch (error) {
      const safe = error instanceof EstimateError || error instanceof CacheError ? error : new EstimateError('server_error', 'The server could not generate estimates. Please retry.', 500);
      send(safe.status, { error: safe.message, code: safe.code, ...(safe.clarification ? { clarification: safe.clarification } : {}) });
    } finally { res.off('close', cancel); }
  };
  middleware.close = () => cache.close();
  return middleware;
}
