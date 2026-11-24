import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBody } from '../server/read-body.mjs';
import { shippingMiddleware } from '../server/middleware.mjs';
import { procurementMiddleware } from '../server/procurement-middleware.mjs';

afterEach(() => vi.useRealTimers());

describe('request body reader', () => {
  it('decodes a UTF-8 character across chunks at the byte limit', async () => {
    const req = new PassThrough();
    const bytes = Buffer.from('{"city":"Zürich"}');
    const split = bytes.indexOf(0xc3) + 1;
    const result = readBody(req, { maxBytes: bytes.length });
    req.write(bytes.subarray(0, split));
    req.end(bytes.subarray(split));
    expect(await result).toEqual({ text: '{"city":"Zürich"}' });
  });

  it('counts bytes instead of characters', async () => {
    const req = new PassThrough();
    const result = readBody(req, { maxBytes: 3 });
    req.end(Buffer.from('üü'));
    expect(await result).toEqual({ error: 'too_large' });
  });

  it('rejects malformed UTF-8 without replacing characters', async () => {
    const req = new PassThrough();
    const result = readBody(req);
    req.end(Buffer.from([0xc3]));
    expect(await result).toEqual({ error: 'invalid_utf8' });
  });

  it('resets the idle timer when another chunk arrives', async () => {
    vi.useFakeTimers();
    const req = new PassThrough();
    const result = readBody(req, { idleMs: 100 });
    await vi.advanceTimersByTimeAsync(60);
    req.write(Buffer.from('{"a":'));
    await vi.advanceTimersByTimeAsync(60);
    req.end(Buffer.from('1}'));
    expect(await result).toEqual({ text: '{"a":1}' });
  });

  it('handles a late stream error after the idle deadline', async () => {
    vi.useFakeTimers();
    const req = new PassThrough();
    const result = readBody(req, { idleMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ error: 'timeout' });
    expect(() => req.emit('error', new Error('connection closed'))).not.toThrow();
    req.emit('close');
    expect(req.listenerCount('error')).toBe(0);
  });

  it('reports a close before the body stream sends its end event', async () => {
    const req = new PassThrough();
    req.complete = true;
    const result = readBody(req);
    req.destroy();
    expect(await result).toEqual({ error: 'aborted' });
  });
});

function response() {
  const res = new EventEmitter();
  res.writeHead = vi.fn();
  res.end = vi.fn();
  return res;
}

function request(path) {
  const req = new PassThrough();
  req.url = path;
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  return req;
}

describe('provider middleware', () => {
  it('releases the comparison lock after an idle request completes', async () => {
    vi.useFakeTimers();
    const middleware = shippingMiddleware(() => ({}), { bodyIdleMs: 100 });
    const path = '/api/shipping/compare';
    const idle = request(path);
    const rejected = response();
    const waiting = middleware(idle, rejected, vi.fn());
    const busy = response();
    await middleware(request(path), busy, vi.fn());
    expect(busy.writeHead).toHaveBeenCalledWith(429, expect.any(Object));

    await vi.advanceTimersByTimeAsync(100);
    await waiting;
    expect(rejected.writeHead).toHaveBeenCalledWith(408, expect.objectContaining({ Connection: 'close' }));
    idle.destroy();

    const next = request(path);
    const accepted = response();
    const handled = middleware(next, accepted, vi.fn());
    next.end(Buffer.from('{'));
    await handled;
    expect(accepted.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(JSON.parse(accepted.end.mock.calls[0][0]).error).toBe('Send a valid JSON parcel request.');
  });

  it('finishes a procurement request at its idle deadline', async () => {
    vi.useFakeTimers();
    const middleware = procurementMiddleware(() => ({}), {}, {}, { bodyIdleMs: 100 });
    try {
      const req = request('/api/procurement/estimates');
      const res = response();
      const handled = middleware(req, res, vi.fn());
      await vi.advanceTimersByTimeAsync(100);
      await handled;
      expect(res.writeHead).toHaveBeenCalledWith(408, expect.objectContaining({ Connection: 'close' }));
      req.destroy();
    } finally {
      await middleware.close();
    }
  });
});

describe.each([
  ['parcel', '/api/shipping/compare', () => shippingMiddleware(() => ({}))],
  ['procurement', '/api/procurement/estimates', () => procurementMiddleware(() => ({}), {}, {})],
])('%s HTTP body handling', (noun, path, makeMiddleware) => {
  it('returns the expected responses and preserves the origin check', async () => {
    const middleware = makeMiddleware();
    const server = http.createServer((req, res) => middleware(req, res, () => res.end()));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}${path}`;
      const post = (body, headers = {}) => fetch(url, {
        method: 'POST', body, headers: { 'content-type': 'application/json', ...headers },
      });
      const wrongOrigin = await post('{}', { Origin: 'https://example.test' });
      expect(wrongOrigin.status).toBe(403);
      await wrongOrigin.json();

      const overLimit = await post(JSON.stringify('é'.repeat(9000)));
      expect(overLimit.status).toBe(413);
      expect(overLimit.headers.get('connection')).toBe('close');
      expect(await overLimit.json()).toEqual({ error: `The ${noun} request is too large.` });

      const badEncoding = await post(Buffer.from([0x22, 0xc3, 0x22]));
      expect(badEncoding.status).toBe(400);
      expect(await badEncoding.json()).toEqual({ error: `Send a valid JSON ${noun} request.` });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await middleware.close?.();
    }
  });
});
