import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer, connect as connectTcp } from 'node:net';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from 'redis';
import { createServer, loadEnv } from 'vite';
import { createRedisCache } from '../server/redis-cache.mjs';
import { createEstimateRunner, MODEL_CONFIGS } from '../server/procurement.mjs';

// This probe never sends requests to a model provider. --configured reads only
// REDIS_URL from local configuration; no real model credentials are used.
// REDIS_VERIFY_URL explicitly selects an existing Redis; --server-bin starts a
// disposable loopback-only Redis and also proves AOF persistence across restart.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

async function freePort() {
  const socket = createTcpServer();
  await new Promise((done, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', done); });
  const port = socket.address().port;
  await new Promise((done, reject) => socket.close((error) => error ? reject(error) : done()));
  return port;
}

async function isolatedRedis(binary) {
  if (!isAbsolute(binary) || !(await stat(binary)).isFile()) throw new Error('Provide an absolute redis-server binary path.');
  const directory = await mkdtemp(join(tmpdir(), 'logisticsnerd-redis-proof-'));
  const port = await freePort();
  const args = ['--bind', '127.0.0.1', '--port', String(port), '--dir', directory, '--appendonly', 'yes', '--appendfsync', 'always', '--save', '', '--daemonize', 'no', '--protected-mode', 'yes', '--logfile', join(directory, 'redis.log')];
  let process;
  async function start() {
    process = spawn(binary, args, { stdio: 'ignore' });
    let failed = false;
    process.once('error', () => { failed = true; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (failed || process.exitCode !== null) throw new Error('The isolated Redis could not start.');
      const ready = await new Promise((done) => {
        const socket = connectTcp({ host: '127.0.0.1', port });
        socket.setTimeout(100);
        const finish = (value) => { socket.removeAllListeners(); socket.destroy(); done(value); };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.once('timeout', () => finish(false));
      });
      if (ready) return;
      await sleep(25);
    }
    throw new Error('The isolated Redis was not ready in time.');
  }
  async function stop() {
    if (!process?.pid || process.exitCode !== null) return;
    const stopped = new Promise((done) => process.once('exit', done));
    process.kill('SIGTERM');
    const timeout = setTimeout(() => process.kill('SIGKILL'), 5000);
    try { await stopped; } finally { clearTimeout(timeout); }
  }
  try { await start(); } catch (error) { await stop(); await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    url: `redis://127.0.0.1:${port}/0`,
    async restart() { await stop(); await start(); },
    async close() { await stop(); await rm(directory, { recursive: true, force: true }); },
  };
}

async function adminConnection(url) {
  const client = createClient({ url, disableOfflineQueue: true, commandOptions: { timeout: 1800 }, socket: { reconnectStrategy: false, connectTimeout: 1800 } });
  client.on('error', () => {});
  try { await client.connect(); return client; } catch { try { client.destroy(); } catch {} throw new Error('The verification Redis could not be reached.'); }
}

async function main() {
  const configuredUrl = process.argv.includes('--configured') ? loadEnv('development', root, '').REDIS_URL : undefined;
  if (process.argv.includes('--configured') && !configuredUrl?.trim()) throw new Error('Redis URL is not configured.');
  const binaryIndex = process.argv.indexOf('--server-bin');
  const isolated = binaryIndex >= 0 ? await isolatedRedis(process.argv[binaryIndex + 1]) : null;
  const redisUrl = isolated?.url ?? configuredUrl ?? process.env.REDIS_VERIFY_URL ?? 'redis://127.0.0.1:6379/0';
  const adapters = new Set();
  const ownedKeys = new Set();
  let admin;
  let vite;
  try {
    admin = await adminConnection(redisUrl);
    vite = await createServer({ root, configFile: false, server: { middlewareMode: true }, appType: 'custom' });
    const [{ compareQuotes }, { validateComparisonInput }] = await Promise.all([
      vite.ssrLoadModule('/src/domain/compare.ts'), vite.ssrLoadModule('/src/domain/validate.ts'),
    ]);
    const unique = randomUUID();
    const catalog = [
      { id: 'verify-value', name: 'Verification Value Goods' },
      { id: 'verify-office', name: 'Verification Office Goods' },
      { id: 'verify-express', name: 'Verification Express Goods' },
    ];
    const dateAfter = (days) => { const date = new Date(); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
    const body = {
      request: {
        id: `verify-request-${unique}`, buyerId: 'verification-only', createdAt: new Date().toISOString(),
        maxBudgetCents: 600000, selectedSupplierIds: catalog.map(({ id }) => id),
        items: [{ id: 'verify-item', name: 'Office chairs', unitLabel: 'chairs', quantity: 50, requiredDate: dateAfter(30) }],
      },
      suppliers: catalog, preference: 'lowest_cost',
    };
    // Unique fake credentials scope generated keys to this probe. Real credentials
    // are not read, and provider calls are replaced with this validated fixture.
    const env = { REDIS_URL: redisUrl, [MODEL_CONFIGS[0].keyName]: `verification-fixture-${unique}` };
    let fakeModelCalls = 0;
    const fetcher = async (_url, { signal }) => {
      fakeModelCalls += 1;
      await sleep(150);
      if (signal.aborted) throw new Error('Cancelled verification fixture.');
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          status: 'estimated', clarification: null,
          assumptions: ['Verification fixture only; no suppliers or models contacted.'],
          quotes: catalog.map(({ id }, index) => ({ supplier_id: id, available_quantity: 50, total_cents: 400000 + index * 50000, expected_delivery_date: dateAfter(14 - index * 2) })),
        }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }), { headers: { 'content-type': 'application/json' } });
    };
    const instance = () => {
      const adapter = createRedisCache({ getEnv: () => env });
      adapters.add(adapter);
      const cache = {
        configured: () => adapter.configured(),
        get: (key, options) => { ownedKeys.add(key); return adapter.get(key, options); },
        acquire: (key, ...args) => { ownedKeys.add(key); return adapter.acquire(key, ...args); },
        release: (...args) => adapter.release(...args),
        complete: (...args) => adapter.complete(...args),
      };
      return { adapter, run: createEstimateRunner({ env, fetcher, rules: { compareQuotes, validateComparisonInput }, catalog, persistentCache: cache, cachePollMs: 25, cacheWaitMs: 3000 }) };
    };
    const first = instance();
    const second = instance();
    const results = await Promise.all([first.run(body), second.run(body)]);
    assert.equal(fakeModelCalls, 1, 'Two app instances must share one generation.');
    assert.equal(results.filter(({ provenance }) => provenance.cached).length, 1, 'One instance must consume the saved shared result.');
    const dataKey = [...ownedKeys].find((key) => key.endsWith(':data'));
    assert.ok(dataKey, 'The runner must use its persistent data key.');
    const originalTtl = await admin.pTTL(dataKey);
    assert.ok(originalTtl > WEEK_MS - 10000 && originalTtl <= WEEK_MS, 'A new cache record must have one-week expiry.');
    const originalValue = await admin.get(dataKey);
    assert.ok(originalValue, 'Generated facts must be saved in Redis.');
    for (const adapter of adapters) await adapter.close();
    adapters.clear();

    let redisRestartSurvived = null;
    if (isolated) {
      admin.destroy();
      admin = null;
      await isolated.restart();
      admin = await adminConnection(redisUrl);
      assert.equal(await admin.get(dataKey), originalValue, 'AOF must preserve cache facts across Redis restart.');
      redisRestartSurvived = true;
    }
    const fresh = instance();
    const adjusted = structuredClone(body);
    adjusted.request.id = `new-request-${unique}`;
    adjusted.request.items[0].id = 'new-item';
    adjusted.request.maxBudgetCents = 1;
    adjusted.preference = 'earliest_delivery';
    const reused = await fresh.run(adjusted);
    assert.equal(fakeModelCalls, 1, 'A new app process must consume Redis without another model call.');
    assert.equal(reused.provenance.cached, true);
    assert.equal(reused.provenance.generatedAt, results[0].provenance.generatedAt);
    assert.equal(reused.provenance.expiresAt, results[0].provenance.expiresAt);
    assert.equal(reused.quotes[0].requestId, adjusted.request.id);
    assert.equal(reused.quotes[0].items[0].requestedItemId, 'new-item');
    assert.equal(reused.comparisons.earliest_delivery.outcome, 'no_feasible_quote');
    const reusedTtl = await admin.pTTL(dataKey);
    assert.ok(reusedTtl > 0 && reusedTtl <= originalTtl, 'Cache reads must not extend the one-week expiry.');

    const lockKey = `logisticsnerd:verify:{${unique}}:lock`;
    const lockDataKey = `logisticsnerd:verify:{${unique}}:data`;
    ownedKeys.add(lockKey); ownedKeys.add(lockDataKey);
    assert.equal(await fresh.adapter.acquire(lockKey, 'expired-owner', 40), true);
    await sleep(65);
    assert.equal(await fresh.adapter.acquire(lockKey, 'current-owner', 90000), true);
    assert.equal(await fresh.adapter.complete(lockKey, 'expired-owner', lockDataKey, 'stale', WEEK_MS), false);
    assert.equal(await fresh.adapter.release(lockKey, 'expired-owner'), false);
    assert.equal(await fresh.adapter.complete(lockKey, 'current-owner', lockDataKey, 'current', WEEK_MS), true);
    assert.equal(await fresh.adapter.get(lockDataKey), 'current');
    assert.equal(await admin.get(lockKey), null);

    let version = 'not reported';
    // Some managed services restrict INFO. That is not a cache failure.
    try {
      const info = await admin.info('server');
      version = info.match(/^redis_version:(.+)$/m)?.[1].trim() ?? version;
    } catch { /* Only the commands needed for caching are required. */ }
    const report = {
      checkedAt: new Date().toISOString(), redisVersion: version, realModelCalls: 0,
      fixtureModelCalls: fakeModelCalls, crossInstanceSingleGeneration: true,
      newAppInstanceCacheReuse: true, redisRestartSurvived,
      originalTtlMs: originalTtl, reusedTtlMs: reusedTtl,
      originalExpiryPreserved: true, expiredLeaseCannotOverwrite: true,
      adjustedRequestComparisonRecomputed: true,
    };
    const reportDirectory = join(root, '.local-planning/api-research/redis-tests');
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(join(reportDirectory, `verification-${Date.now()}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    for (const adapter of adapters) await adapter.close();
    // Never FLUSHDB: remove only this probe's uniquely scoped data and leases.
    try {
      if (admin?.isReady && ownedKeys.size) await admin.del([...ownedKeys]);
    } finally {
      try { admin?.destroy(); } catch {}
      try { await vite?.close(); } finally { await isolated?.close(); }
    }
  }
}

main().catch((error) => {
  const message = error instanceof assert.AssertionError ? error.message : 'Redis verification failed. Check that the selected Redis URL is configured, reachable, and accepts GET, SET, EVAL, DEL and PTTL.';
  console.error(message);
  process.exitCode = 1;
});
