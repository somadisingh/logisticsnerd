import http from 'node:http';
import net from 'node:net';
import { describe, expect, it, afterEach } from 'vitest';
import { readBody, bodyFailure } from '../server/read-body.mjs';
import { shippingMiddleware } from '../server/middleware.mjs';
import { procurementMiddleware } from '../server/procurement-middleware.mjs';

const servers = [];
afterEach(async () => { while (servers.length) await new Promise((r) => servers.pop().close(r)); });

async function serve(handler) {
  const srv = http.createServer(handler);
  srv.closeAllConnections?.();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return srv.address().port;
}
const head = (port, path, len) => `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${len}\r\nConnection: close\r\n\r\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rawRequest(port, path, parts, { gap = 30, end = true, extra = 0 } = {}) {
  return new Promise(async (resolve) => {
    const total = parts.reduce((n, p) => n + p.length, 0) + (end ? 0 : 1000);
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('data', (d) => { out += d; });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    s.write(head(port, path, total));
    for (const part of parts) { s.write(part); await sleep(gap); }
    if (!end) resolve({ socket: s, read: () => out });
  });
}
const status = (raw) => Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1]);

describe('readBody', () => {
  const run = async (opts, send) => {
    let result;
    const port = await serve(async (req, res) => { result = await readBody(req, opts); res.end('ok'); });
    await send(port);
    await sleep(60);
    return result;
  };
  it('returns the text of a small body', async () => {
    const r = await run({}, (p) => rawRequest(p, '/x', [Buffer.from('{"a":1}')]));
    expect(r).toEqual({ text: '{"a":1}' });
  });
  it('keeps a multibyte character that is split across chunks', async () => {
    const body = Buffer.from('{"city":"Zürich"}');
    const i = body.indexOf(0xc3) + 1;
    const r = await run({}, (p) => rawRequest(p, '/x', [body.subarray(0, i), body.subarray(i)]));
    expect(r.text).toBe('{"city":"Zürich"}');
    expect(r.text).not.toContain('\uFFFD');
  });
  it('rejects a body over the byte limit', async () => {
    const r = await run({ maxBytes: 10 }, (p) => rawRequest(p, '/x', [Buffer.from('x'.repeat(11))]));
    expect(r).toEqual({ error: 'too_large' });
  });
  it('counts bytes, not characters', async () => {
    const r = await run({ maxBytes: 10 }, (p) => rawRequest(p, '/x', [Buffer.from('ü'.repeat(6))]));
    expect(r).toEqual({ error: 'too_large' });
  });
  it('accepts a body exactly at the limit', async () => {
    const r = await run({ maxBytes: 10 }, (p) => rawRequest(p, '/x', [Buffer.from('x'.repeat(10))]));
    expect(r).toEqual({ text: 'x'.repeat(10) });
  });
  it('times out when the client stops sending', async () => {
    const r = await run({ idleMs: 80 }, async (p) => {
      const { socket } = await rawRequest(p, '/x', [Buffer.from('{"a"')], { end: false });
      await sleep(250);
      socket.destroy();
    });
    expect(r).toEqual({ error: 'timeout' });
  });
  it('does not time out a slow but steady sender', async () => {
    const r = await run({ idleMs: 150 }, (p) => rawRequest(p, '/x', [Buffer.from('{"a"'), Buffer.from(':1'), Buffer.from('}')], { gap: 60 }));
    expect(r).toEqual({ text: '{"a":1}' });
  });
  it('reports an aborted request when the client disconnects early', async () => {
    const r = await run({ idleMs: 2000 }, async (p) => {
      const { socket } = await rawRequest(p, '/x', [Buffer.from('{"a"')], { end: false });
      await sleep(50);
      socket.destroy();
    });
    expect(r).toEqual({ error: 'aborted' });
  });
});

describe('bodyFailure', () => {
  it('maps errors to statuses', () => {
    expect(bodyFailure('too_large', 'parcel')[0]).toBe(413);
    expect(bodyFailure('timeout', 'parcel')[0]).toBe(408);
    expect(bodyFailure('aborted', 'parcel')[0]).toBe(400);
    expect(bodyFailure('too_large', 'parcel')[1]).toBe('The parcel request is too large.');
  });
});

describe('shipping middleware', () => {
  const make = async () => {
    const mw = shippingMiddleware(() => ({}));
    return serve((req, res) => mw(req, res, () => { res.writeHead(404); res.end(); }));
  };
  it('still answers 413 for an oversized request', async () => {
    const port = await make();
    const raw = await rawRequest(port, '/api/shipping/compare', [Buffer.from('x'.repeat(17000))]);
    expect(status(raw)).toBe(413);
    expect(raw).toContain('The parcel request is too large.');
  });
  it('still answers 400 for invalid JSON', async () => {
    const port = await make();
    const raw = await rawRequest(port, '/api/shipping/compare', [Buffer.from('{nope')]);
    expect(status(raw)).toBe(400);
    expect(raw).toContain('Send a valid JSON parcel request.');
  });
  it('frees the comparison lock when a stalled client disconnects, and while stalled still says 429', async () => {
    const port = await make();
    const { socket } = await rawRequest(port, '/api/shipping/compare', [Buffer.from('{"parcel":')], { end: false });
    await sleep(100);
    const busy = await fetch(`http://127.0.0.1:${port}/api/shipping/compare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(busy.status).toBe(429);
    socket.destroy();
    await sleep(150);
    const free = await fetch(`http://127.0.0.1:${port}/api/shipping/compare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(free.status).toBe(400);
  });
});

describe('stalled clients', () => {
  it('shipping: a client that stops sending without disconnecting gets 408 and frees the lock', async () => {
    const mw = shippingMiddleware(() => ({}), { bodyIdleMs: 120 });
    const port = await serve((req, res) => mw(req, res, () => { res.writeHead(404); res.end(); }));
    const stalled = await rawRequest(port, '/api/shipping/compare', [Buffer.from('{"parcel":')], { end: false });
    await sleep(40);
    const busy = await fetch(`http://127.0.0.1:${port}/api/shipping/compare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(busy.status).toBe(429);
    await sleep(250);
    expect(status(stalled.read())).toBe(408);
    expect(stalled.read()).toContain('took too long');
    const free = await fetch(`http://127.0.0.1:${port}/api/shipping/compare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(free.status).toBe(400);
    stalled.socket.destroy();
  });
  it('procurement: a client that stops sending gets 408', async () => {
    const mw = procurementMiddleware(() => ({}), {}, {}, { bodyIdleMs: 120 });
    const port = await serve((req, res) => mw(req, res, () => { res.writeHead(404); res.end(); }));
    const stalled = await rawRequest(port, '/api/procurement/estimates', [Buffer.from('{"items":')], { end: false });
    await sleep(300);
    expect(status(stalled.read())).toBe(408);
    stalled.socket.destroy();
    mw.close?.();
  });
});

describe('procurement middleware', () => {
  it('still answers 413 for an oversized request', async () => {
    const mw = procurementMiddleware(() => ({}), {}, {});
    const port = await serve((req, res) => mw(req, res, () => { res.writeHead(404); res.end(); }));
    const raw = await rawRequest(port, '/api/procurement/estimates', [Buffer.from('x'.repeat(17000))]);
    expect(status(raw)).toBe(413);
    expect(raw).toContain('The procurement request is too large.');
    mw.close?.();
  });
});
