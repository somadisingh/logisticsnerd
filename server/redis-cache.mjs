import { createClient } from 'redis';

const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;
const COMPLETE_SCRIPT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
redis.call('DEL', KEYS[1])
return 1`;

export class CacheError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'CacheError';
    this.code = code;
    this.status = status;
  }
}

const unavailable = () => new CacheError('cache_unavailable', 'Redis cache is unavailable. Please retry shortly.');
const cancelled = () => new CacheError('cancelled', 'Estimate request cancelled.', 499);
const invalidRequest = () => new CacheError('cache_error', 'The server cache request is invalid.', 500);
const validKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= 500;
const validToken = (token) => typeof token === 'string' && token.length > 0 && token.length <= 200;
const validTtl = (ttl) => Number.isSafeInteger(ttl) && ttl > 0 && ttl <= MAX_TTL_MS;
const validValue = (value) => typeof value === 'string' && value.length <= 131072;

function redisUrl(getEnv) {
  let value;
  try { value = getEnv()?.REDIS_URL; } catch { throw new CacheError('cache_config_error', 'Redis cache configuration is invalid.', 500); }
  if (typeof value !== 'string' || !value.trim()) throw new CacheError('needs_cache_configuration', 'Set REDIS_URL on the server to enable the persistent cache.');
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname || parsed.search || parsed.hash || !/^\/(?:\d+)?$/.test(parsed.pathname || '/')) throw new Error();
  } catch {
    // URL parsers and clients can include credentials in their own error text.
    throw new CacheError('cache_config_error', 'Redis cache configuration is invalid.', 500);
  }
  return trimmed;
}

function waitFor(promise, { signal, timeoutMs, onTimeout } = {}) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const finish = (action, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      action(value);
    };
    const abort = () => finish(reject, cancelled());
    // Attach both handlers even if the caller aborts, to consume late failures.
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => {
      onTimeout?.();
      finish(reject, unavailable());
    }, timeoutMs);
  });
}

/**
 * One lazy Redis connection per app server. Connection failures are cooled down
 * instead of retried in the background; commands are never replayed after loss.
 * Redis cannot undo a command already received when its caller cancels. Locks
 * therefore always have a bounded TTL, and completion checks the owner token.
 */
export function createRedisCache({
  getEnv = () => process.env,
  clientFactory = createClient,
  timeoutMs = 1800,
  reconnectCooldownMs = 5000,
  now = Date.now,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000 || !Number.isFinite(reconnectCooldownMs) || reconnectCooldownMs < 0) throw invalidRequest();
  let client;
  let connecting;
  let activeUrl;
  let retryAfter = 0;
  let closed = false;

  const dispose = (target) => {
    try { target?.destroy(); } catch { /* Already disconnected; never log driver errors. */ }
  };
  const invalidate = (target) => {
    dispose(target);
    if (client !== target) return;
    client = undefined;
    retryAfter = now() + reconnectCooldownMs;
  };

  function connection() {
    if (closed) throw unavailable();
    const url = redisUrl(getEnv);
    if (activeUrl !== url) {
      dispose(client);
      client = undefined;
      connecting = undefined;
      activeUrl = url;
      retryAfter = 0;
    }
    if (client?.isReady) return Promise.resolve(client);
    if (connecting) return connecting;
    if (now() < retryAfter) throw unavailable();
    dispose(client);
    let target;
    try {
      target = clientFactory({
        url,
        disableOfflineQueue: true,
        commandsQueueMaxLength: 100,
        commandOptions: { timeout: timeoutMs },
        maintNotifications: 'disabled',
        socket: { connectTimeout: timeoutMs, reconnectStrategy: false },
      });
      // An error listener is mandatory in node-redis. Driver messages can contain
      // connection details, so failures are classified at the request boundary.
      target.on('error', () => {});
      client = target;
    } catch {
      dispose(target);
      retryAfter = now() + reconnectCooldownMs;
      throw unavailable();
    }
    let attempt;
    attempt = waitFor(Promise.resolve().then(() => target.connect()), { timeoutMs, onTimeout: () => invalidate(target) })
      .then(() => {
        if (closed || client !== target || activeUrl !== url || !target.isReady) throw unavailable();
        return target;
      })
      .catch(() => { invalidate(target); throw unavailable(); })
      .finally(() => { if (connecting === attempt) connecting = undefined; });
    connecting = attempt;
    return attempt;
  }

  async function command(args, { signal } = {}) {
    if (signal?.aborted) throw cancelled();
    let target;
    const timeoutController = new AbortController();
    const commandSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    try {
      // Cancellation detaches this caller; it does not cancel another caller's
      // shared lazy connection attempt.
      target = await waitFor(connection(), { signal });
      if (signal?.aborted) throw cancelled();
      if (!target.isReady) throw unavailable();
      return await waitFor(Promise.resolve().then(() => target.sendCommand(args, { abortSignal: commandSignal, timeout: timeoutMs })), {
        signal,
        timeoutMs,
        onTimeout: () => { timeoutController.abort(); invalidate(target); },
      });
    } catch (error) {
      if (signal?.aborted || error?.code === 'cancelled') throw cancelled();
      if (target) invalidate(target);
      if (error instanceof CacheError) throw error;
      throw unavailable();
    } finally {
      timeoutController.abort();
    }
  }

  return {
    configured() {
      try { const value = getEnv()?.REDIS_URL; return typeof value === 'string' && !!value.trim(); } catch { return false; }
    },
    async get(key, options) {
      if (!validKey(key)) throw invalidRequest();
      const value = await command(['GET', key], options);
      if (value !== null && (typeof value !== 'string' || value.length > 131072)) throw unavailable();
      return value;
    },
    async put(key, value, ttlMs, options) {
      if (!validKey(key) || !validValue(value) || !validTtl(ttlMs)) throw invalidRequest();
      if (await command(['SET', key, value, 'PX', String(ttlMs)], options) !== 'OK') throw unavailable();
    },
    async acquire(key, token, ttlMs, options) {
      if (!validKey(key) || !validToken(token) || !validTtl(ttlMs)) throw invalidRequest();
      const value = await command(['SET', key, token, 'PX', String(ttlMs), 'NX'], options);
      if (value !== 'OK' && value !== null) throw unavailable();
      return value === 'OK';
    },
    async release(key, token, options) {
      if (!validKey(key) || !validToken(token)) throw invalidRequest();
      const value = await command(['EVAL', RELEASE_SCRIPT, '1', key, token], options);
      if (value !== 0 && value !== 1) throw unavailable();
      return value === 1;
    },
    async complete(lockKey, token, dataKey, value, ttlMs, options) {
      if (!validKey(lockKey) || !validKey(dataKey) || lockKey === dataKey || !validToken(token) || !validValue(value) || !validTtl(ttlMs)) throw invalidRequest();
      const result = await command(['EVAL', COMPLETE_SCRIPT, '2', lockKey, dataKey, token, value, String(ttlMs)], options);
      if (result !== 0 && result !== 1) throw unavailable();
      return result === 1;
    },
    async close() {
      closed = true;
      dispose(client);
      client = undefined;
      connecting = undefined;
    },
  };
}
