// Reads a JSON request body with a byte limit and an inactivity deadline.
// Returns { text } or { error: 'too_large' | 'timeout' | 'aborted' }.
export const MAX_BODY_BYTES = 16384;
export const BODY_IDLE_MS = 10000;

export function readBody(req, { maxBytes = MAX_BODY_BYTES, idleMs = BODY_IDLE_MS } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let timer;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      resolve(result);
    };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish({ error: 'timeout' }), idleMs); };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) return finish({ error: 'too_large' });
      chunks.push(chunk);
      arm();
    };
    const onEnd = () => finish({ text: Buffer.concat(chunks).toString('utf8') });
    const onError = () => finish({ error: 'aborted' });
    const onClose = () => { if (!req.complete) finish({ error: 'aborted' }); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
    arm();
  });
}

export function bodyFailure(error, noun) {
  if (error === 'too_large') return [413, `The ${noun} request is too large.`];
  if (error === 'timeout') return [408, `The ${noun} request took too long to arrive.`];
  return [400, `The ${noun} request was interrupted.`];
}
