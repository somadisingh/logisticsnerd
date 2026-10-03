import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheError, createRedisCache } from '../server/redis-cache.mjs';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const KEY = 'logisticsnerd:estimates:v4:{test}:data';
const LOCK = 'logisticsnerd:estimates:v4:{test}:lock';
const PRIVATE_URL = 'rediss://demo-user:private-test-password@redis.example.test:6380/2';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  let clock = 1000000;
  const env = { REDIS_URL: PRIVATE_URL };
  const stored = new Map();
  const clients = [];
  const read = (key) => {
    const entry = stored.get(key);
    if (entry && entry.expiresAt <= clock) { stored.delete(key); return null; }
    return entry?.value ?? null;
  };
  const factory = vi.fn((options) => {
    const client = new EventEmitter();
    client.isReady = false;
    client.isOpen = false;
    client.options = options;
    client.connect = vi.fn(async () => { client.isReady = true; client.isOpen = true; });
    client.destroy = vi.fn(() => { client.isReady = false; client.isOpen = false; });
    client.sendCommand = vi.fn(async (args) => {
      if (!client.isReady) throw new Error('Client offline');
      if (args[0] === 'GET') return read(args[1]);
      if (args[0] === 'SET') {
        if (args.includes('NX') && read(args[1]) !== null) return null;
        stored.set(args[1], { value: args[2], expiresAt: clock + Number(args[4]) });
        return 'OK';
      }
      if (args[0] === 'EVAL' && args[2] === '1') {
        if (read(args[3]) !== args[4]) return 0;
        stored.delete(args[3]);
        return 1;
      }
      if (args[0] === 'EVAL' && args[2] === '2') {
        if (read(args[3]) !== args[5]) return 0;
        stored.set(args[4], { value: args[6], expiresAt: clock + Number(args[7]) });
        stored.delete(args[3]);
        return 1;
      }
      throw new Error('Unsupported test command');
    });
    clients.push(client);
    return client;
  });
  const cache = createRedisCache({ getEnv: () => env, clientFactory: factory, now: () => clock, ...overrides });
  return { cache, factory, clients, stored, env, advance: (ms) => { clock += ms; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('Redis cache connection and safe failures', () => {
  it('connects lazily and reuses one connection with bounded, replay-free settings', async () => {
    const { cache, factory, clients } = fixture();
    expect(cache.configured()).toBe(true);
    expect(factory).not.toHaveBeenCalled();
    expect(await cache.get(KEY)).toBeNull();
    expect(await cache.get(KEY)).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(clients[0].connect).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({
      url: PRIVATE_URL, disableOfflineQueue: true, commandsQueueMaxLength: 100,
      commandOptions: { timeout: 1800 }, maintNotifications: 'disabled',
      socket: { connectTimeout: 1800, reconnectStrategy: false },
    });
    expect(clients[0].listenerCount('error')).toBe(1);
    expect(clients[0].sendCommand.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
    expect(clients[0].sendCommand.mock.calls[0][1].timeout).toBe(1800);
  });

  it.each(['', '   ', undefined])('requires a configured connection before any command: %s', async (url) => {
    const { cache, env, factory } = fixture();
    env.REDIS_URL = url;
    expect(cache.configured()).toBe(false);
    await expect(cache.get(KEY)).rejects.toMatchObject({ code: 'needs_cache_configuration', status: 503 });
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    'https://user:private-test-password@example.test',
    'redis://user:private-test-password@',
    'redis://localhost/invalid-database',
    'redis://localhost/0?password=private-test-password',
    'redis://localhost/0#private-test-password',
  ])('rejects invalid URLs without exposing connection text: %s', async (url) => {
    const { cache, env, factory } = fixture();
    env.REDIS_URL = url;
    const error = await cache.get(KEY).catch((caught) => caught);
    expect(error).toBeInstanceOf(CacheError);
    expect(error).toMatchObject({ code: 'cache_config_error', status: 500 });
    expect(String(error)).not.toContain('private-test-password');
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not expose constructor, connection, or command errors from Redis', async () => {
    const constructorFailure = fixture({ clientFactory: () => { throw new Error(PRIVATE_URL); } });
    await expect(constructorFailure.cache.get(KEY)).rejects.toMatchObject({ code: 'cache_unavailable' });
    const connectionFailure = fixture();
    connectionFailure.factory.mockImplementationOnce(() => {
      const client = new EventEmitter();
      client.connect = async () => { throw new Error(PRIVATE_URL); };
      client.destroy = vi.fn();
      return client;
    });
    const connectionError = await connectionFailure.cache.get(KEY).catch((error) => error);
    expect(String(connectionError)).not.toContain('private-test-password');
    const commandFailure = fixture();
    await commandFailure.cache.get(KEY);
    commandFailure.clients[0].sendCommand.mockRejectedValueOnce(new Error(PRIVATE_URL));
    const commandError = await commandFailure.cache.get(KEY).catch((error) => error);
    expect(commandError).toMatchObject({ code: 'cache_unavailable' });
    expect(String(commandError)).not.toContain('private-test-password');
  });

  it('bounds a hung connection and cools down retries before reconnecting on a later request', async () => {
    vi.useFakeTimers();
    const { cache, factory, advance } = fixture({ timeoutMs: 30 });
    const held = deferred();
    const firstClient = new EventEmitter();
    firstClient.connect = vi.fn(() => held.promise);
    firstClient.destroy = vi.fn();
    factory.mockReturnValueOnce(firstClient);
    const request = cache.get(KEY);
    const failure = expect(request).rejects.toMatchObject({ code: 'cache_unavailable' });
    await vi.advanceTimersByTimeAsync(31);
    await failure;
    expect(firstClient.destroy).toHaveBeenCalled();
    await expect(cache.get(KEY)).rejects.toMatchObject({ code: 'cache_unavailable' });
    expect(factory).toHaveBeenCalledTimes(1);
    advance(5000);
    expect(await cache.get(KEY)).toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
    held.reject(new Error(PRIVATE_URL));
    await Promise.resolve();
    expect(await cache.get(KEY)).toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('bounds a hung command, closes its connection, and never replays that command', async () => {
    vi.useFakeTimers();
    const { cache, clients, factory } = fixture({ timeoutMs: 30 });
    await cache.get(KEY);
    const held = deferred();
    clients[0].sendCommand.mockReturnValueOnce(held.promise);
    const request = cache.acquire(LOCK, 'owner', 90000);
    const failure = expect(request).rejects.toMatchObject({ code: 'cache_unavailable' });
    await vi.advanceTimersByTimeAsync(31);
    await failure;
    expect(clients[0].destroy).toHaveBeenCalled();
    await expect(cache.get(KEY)).rejects.toMatchObject({ code: 'cache_unavailable' });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(clients[0].sendCommand.mock.calls.filter(([args]) => args[0] === 'SET')).toHaveLength(1);
    held.resolve('OK');
    await Promise.resolve();
  });

  it('replaces a disconnected client on a later request', async () => {
    const { cache, clients, factory } = fixture();
    await cache.get(KEY);
    clients[0].isReady = false;
    clients[0].isOpen = false;
    expect(await cache.get(KEY)).toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(clients[0].destroy).toHaveBeenCalled();
  });

  it('rotates the connection when server configuration changes', async () => {
    const { cache, clients, factory, env } = fixture();
    await cache.get(KEY);
    env.REDIS_URL = 'redis://127.0.0.1:6379/0';
    await cache.get(KEY);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(clients[0].destroy).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[1][0].url).toBe(env.REDIS_URL);
  });

  it('does not let a late old connection invalidate its replacement after URL rotation', async () => {
    const { cache, factory, env } = fixture();
    const held = deferred();
    const oldClient = new EventEmitter();
    oldClient.isReady = false;
    oldClient.connect = vi.fn(async () => { await held.promise; oldClient.isReady = true; });
    oldClient.destroy = vi.fn(() => { oldClient.isReady = false; });
    factory.mockReturnValueOnce(oldClient);
    const original = cache.get(KEY);
    const originalFailure = expect(original).rejects.toMatchObject({ code: 'cache_unavailable' });
    await Promise.resolve();
    env.REDIS_URL = 'redis://127.0.0.1:6379/0';
    expect(await cache.get(KEY)).toBeNull();
    held.resolve();
    await originalFailure;
    expect(await cache.get(KEY)).toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('closes without requiring Redis connectivity and prevents reuse of a disposed adapter', async () => {
    const { cache, clients, factory } = fixture();
    await cache.get(KEY);
    await cache.close();
    await cache.close();
    expect(clients[0].destroy).toHaveBeenCalledTimes(1);
    await expect(cache.get(KEY)).rejects.toMatchObject({ code: 'cache_unavailable' });
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('Redis cache TTL and distributed lock ownership', () => {
  it('stores raw serialized validated facts for one week without extending expiry on reads', async () => {
    const { cache, clients, stored, advance } = fixture();
    const value = JSON.stringify({ quotes: ['validated by the estimate runner'] });
    await cache.put(KEY, value, WEEK_MS);
    expect(stored.get(KEY).expiresAt).toBe(1000000 + WEEK_MS);
    advance(WEEK_MS - 1);
    expect(await cache.get(KEY)).toBe(value);
    expect(stored.get(KEY).expiresAt).toBe(1000000 + WEEK_MS);
    advance(1);
    expect(await cache.get(KEY)).toBeNull();
    expect(clients[0].sendCommand.mock.calls.filter(([args]) => args[0] === 'SET')).toHaveLength(1);
  });

  it('grants one NX lease per key and allows a new owner after lease expiry', async () => {
    const { cache, advance, clients } = fixture();
    expect(await cache.acquire(LOCK, 'first-owner', 90000)).toBe(true);
    expect(await cache.acquire(LOCK, 'second-owner', 90000)).toBe(false);
    expect(clients[0].sendCommand.mock.calls[0][0]).toEqual(['SET', LOCK, 'first-owner', 'PX', '90000', 'NX']);
    advance(90000);
    expect(await cache.acquire(LOCK, 'second-owner', 90000)).toBe(true);
  });

  it('releases only a lock with the matching owner token', async () => {
    const { cache, stored, clients } = fixture();
    await cache.acquire(LOCK, 'new-owner', 90000);
    expect(await cache.release(LOCK, 'old-owner')).toBe(false);
    expect(stored.get(LOCK).value).toBe('new-owner');
    expect(await cache.release(LOCK, 'new-owner')).toBe(true);
    expect(stored.has(LOCK)).toBe(false);
    const script = clients[0].sendCommand.mock.calls.find(([args]) => args[0] === 'EVAL')[0];
    expect(script[1]).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    expect(script[1]).toContain("redis.call('DEL', KEYS[1])");
  });

  it('atomically stores the owner result with TTL and deletes its lock', async () => {
    const { cache, stored, clients } = fixture();
    await cache.acquire(LOCK, 'current-owner', 90000);
    expect(await cache.complete(LOCK, 'current-owner', KEY, '{"valid":true}', WEEK_MS)).toBe(true);
    expect(stored.has(LOCK)).toBe(false);
    expect(await cache.get(KEY)).toBe('{"valid":true}');
    expect(stored.get(KEY).expiresAt).toBe(1000000 + WEEK_MS);
    const script = clients[0].sendCommand.mock.calls.find(([args]) => args[0] === 'EVAL')[0];
    expect(script.slice(2)).toEqual(['2', LOCK, KEY, 'current-owner', '{"valid":true}', String(WEEK_MS)]);
    expect(script[1]).toContain("redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])");
    expect(script[1]).toContain("redis.call('DEL', KEYS[1])");
  });

  it('prevents an expired owner overwriting results or deleting a replacement lease', async () => {
    const { cache, stored, advance } = fixture();
    await cache.acquire(LOCK, 'expired-owner', 90000);
    advance(90000);
    await cache.acquire(LOCK, 'replacement-owner', 90000);
    await cache.put(KEY, 'replacement-result', WEEK_MS);
    const expiry = stored.get(KEY).expiresAt;
    expect(await cache.complete(LOCK, 'expired-owner', KEY, 'stale-result', WEEK_MS)).toBe(false);
    expect(await cache.get(KEY)).toBe('replacement-result');
    expect(stored.get(KEY).expiresAt).toBe(expiry);
    expect(stored.get(LOCK).value).toBe('replacement-owner');
    expect(await cache.release(LOCK, 'expired-owner')).toBe(false);
  });

  it.each([0, -1, 1.5, WEEK_MS + 1, Infinity])('rejects invalid TTL before contacting Redis: %s', async (ttl) => {
    const { cache, factory } = fixture();
    await expect(cache.put(KEY, '{}', ttl)).rejects.toMatchObject({ code: 'cache_error' });
    await expect(cache.acquire(LOCK, 'owner', ttl)).rejects.toMatchObject({ code: 'cache_error' });
    await expect(cache.complete(LOCK, 'owner', KEY, '{}', ttl)).rejects.toMatchObject({ code: 'cache_error' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects malformed internal requests and unexpected Redis replies safely', async () => {
    const { cache, clients, factory } = fixture();
    await expect(cache.get('')).rejects.toMatchObject({ code: 'cache_error' });
    await expect(cache.put(KEY, { unsafe: true }, 1000)).rejects.toMatchObject({ code: 'cache_error' });
    await expect(cache.put(KEY, 'x'.repeat(131073), 1000)).rejects.toMatchObject({ code: 'cache_error' });
    await expect(cache.acquire(LOCK, '', 1000)).rejects.toMatchObject({ code: 'cache_error' });
    await expect(cache.release(LOCK, '')).rejects.toMatchObject({ code: 'cache_error' });
    await expect(cache.complete(KEY, 'owner', KEY, '{}', 1000)).rejects.toMatchObject({ code: 'cache_error' });
    expect(factory).not.toHaveBeenCalled();
    await cache.get(KEY);
    clients[0].sendCommand.mockResolvedValueOnce({ wrong: 'type' });
    await expect(cache.get(KEY)).rejects.toMatchObject({ code: 'cache_unavailable' });
    clients[0].sendCommand.mockResolvedValueOnce('unexpected');
    await expect(cache.acquire(LOCK, 'owner', 1000)).rejects.toMatchObject({ code: 'cache_unavailable' });
  });
});

describe('Redis request cancellation', () => {
  it('does not connect for an already cancelled request', async () => {
    const { cache, factory } = fixture();
    await expect(cache.get(KEY, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled', status: 499 });
    expect(factory).not.toHaveBeenCalled();
  });

  it('lets another caller finish a shared connection when one caller cancels', async () => {
    const { cache, factory } = fixture();
    const held = deferred();
    const client = new EventEmitter();
    client.isReady = false;
    client.connect = vi.fn(async () => { await held.promise; client.isReady = true; });
    client.sendCommand = vi.fn(async () => null);
    client.destroy = vi.fn(() => { client.isReady = false; });
    factory.mockReturnValueOnce(client);
    const controller = new AbortController();
    const first = cache.get(KEY, { signal: controller.signal });
    const failure = expect(first).rejects.toMatchObject({ code: 'cancelled' });
    const second = cache.get(KEY);
    controller.abort();
    await failure;
    expect(client.destroy).not.toHaveBeenCalled();
    held.resolve();
    expect(await second).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(client.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('aborts one pending command without destroying another caller connection', async () => {
    const { cache, clients } = fixture();
    await cache.get(KEY);
    const held = deferred();
    clients[0].sendCommand.mockReturnValueOnce(held.promise);
    const controller = new AbortController();
    const request = cache.get(KEY, { signal: controller.signal });
    const failure = expect(request).rejects.toMatchObject({ code: 'cancelled' });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await failure;
    expect(clients[0].destroy).not.toHaveBeenCalled();
    expect(await cache.get(KEY)).toBeNull();
    held.reject(new Error(PRIVATE_URL));
    await Promise.resolve();
  });
});
