import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceProxies } from '../server/workspace-proxy.mjs';

const token = 'server-only-test-credential';
const configured = () => ({ LOGISTICS_API_TOKEN: token });

function request(options, headers = {}) {
  const req = { headers: { host: '127.0.0.1:5173', ...headers }, socket: {} };
  const res = {
    writeHead: vi.fn(function (status) { this.status = status; }),
    end: vi.fn(function (body) { this.body = JSON.parse(body); this.writableEnded = true; }),
  };
  const result = options.bypass(req, res);
  return { result, res };
}

describe('automatic local workspace access', () => {
  it('covers all persistent pages in development and preview', () => {
    expect(Object.keys(createWorkspaceProxies(configured))).toEqual([
      '/api/purchasing', '/api/business', '/api/fulfillment',
    ]);
  });

  it.each([
    {},
    { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin' },
    { host: 'localhost:5173', origin: 'http://localhost:5173' },
    { host: '[::1]:5173', origin: 'http://[::1]:5173' },
    { 'sec-fetch-site': 'none' },
  ])('opens the local workspace without a browser token: %j', headers => {
    const { result, res } = request(createWorkspaceProxies(configured)['/api/business'], headers);
    expect(result).toBeUndefined();
    expect(res.end).not.toHaveBeenCalled();
  });

  it.each([
    { origin: 'https://another-site.example' },
    { origin: 'null' },
    { origin: 'http://127.0.0.1:9999' },
    { host: 'another-site.example:5173' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ])('rejects other origins before forwarding credentials: %j', headers => {
    const { result, res } = request(createWorkspaceProxies(configured)['/api/business'], headers);
    expect(result).toBe('');
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('adds the credential only to the backend proxy request', () => {
    const options = createWorkspaceProxies(configured)['/api/purchasing'];
    const proxy = new EventEmitter();
    options.configure(proxy);
    const backendRequest = { setHeader: vi.fn() };
    proxy.emit('proxyReq', backendRequest);
    expect(backendRequest.setHeader).toHaveBeenCalledWith('Authorization', `Bearer ${token}`);
    expect(options.headers).toBeUndefined();
  });

  it('reports missing server configuration without exposing credentials', () => {
    const { result, res } = request(createWorkspaceProxies(() => ({}))['/api/business']);
    expect(result).toBe('');
    expect(res.status).toBe(503);
    expect(res.body.error.message).toContain('server');
    expect(JSON.stringify(res.body)).not.toContain('Bearer');
  });
});
