// The local UI uses the server's credential; browsers never receive a token.
// These routes stay on the loopback development server and reject other sites.
const prefixes = ['/api/purchasing', '/api/business', '/api/fulfillment'];

export function createWorkspaceProxies(getEnv, target = 'http://127.0.0.1:8001') {
  function reject(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: { message } }));
    // Vite stops processing a string bypass once the response has ended.
    return '';
  }

  const options = () => ({
    target,
    bypass(req, res) {
      let ownOrigin;
      try {
        const host = new URL(`http://${req.headers.host}`);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) {
          return reject(res, 403, 'Open the workspace on this computer.');
        }
        ownOrigin = `${req.socket?.encrypted ? 'https:' : 'http:'}//${host.host}`;
      } catch {
        return reject(res, 403, 'Open the workspace on this computer.');
      }
      const site = req.headers['sec-fetch-site'];
      if ((req.headers.origin && req.headers.origin !== ownOrigin) ||
          (site && site !== 'same-origin' && site !== 'none')) {
        return reject(res, 403, 'Use the local workspace page for this request.');
      }
      if (!getEnv().LOGISTICS_API_TOKEN?.trim()) {
        return reject(res, 503, 'The local workspace server is not configured. Check its environment file.');
      }
      return undefined;
    },
    configure(proxy) {
      proxy.on('proxyReq', proxyReq => {
        proxyReq.setHeader('Authorization', `Bearer ${getEnv().LOGISTICS_API_TOKEN?.trim() ?? ''}`);
      });
    },
  });

  return Object.fromEntries(prefixes.map(prefix => [prefix, options()]));
}
