const MAX_BODY_BYTES = 16 * 1024;
const BODY_IDLE_MS = 10_000;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function readBody(req, { maxBytes = MAX_BODY_BYTES, idleMs = BODY_IDLE_MS } = {}) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    let timer;
    let settled = false;

    const removeCloseHandlers = () => {
      req.off('error', onError);
      req.off('close', onClose);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      if (result.error === 'timeout' || result.error === 'too_large') {
        // Handle a late stream error until the rejection closes the connection.
        req.resume();
      } else {
        removeCloseHandlers();
      }
      resolve(result);
    };
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ error: 'timeout' }), idleMs);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) return finish({ error: 'too_large' });
      chunks.push(chunk);
      resetTimer();
    };
    const onEnd = () => {
      try {
        finish({ text: utf8.decode(Buffer.concat(chunks)) });
      } catch {
        finish({ error: 'invalid_utf8' });
      }
    };
    const onError = () => finish({ error: 'aborted' });
    const onClose = () => {
      finish({ error: 'aborted' });
      removeCloseHandlers();
    };

    if (req.destroyed) return finish({ error: 'aborted' });
    req.on('error', onError);
    req.once('close', onClose);
    req.once('end', onEnd);
    req.on('data', onData);
    resetTimer();
  });
}

export function sendBodyFailure(send, error, noun) {
  switch (error) {
    case 'too_large':
      return send(413, { error: `The ${noun} request is too large.` }, { Connection: 'close' });
    case 'timeout':
      return send(408, { error: `The ${noun} request took too long to arrive.` }, { Connection: 'close' });
    case 'invalid_utf8':
      return send(400, { error: `Send a valid JSON ${noun} request.` });
    default:
      return send(400, { error: `The ${noun} request was interrupted.` });
  }
}
