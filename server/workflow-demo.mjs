import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const endpoint = '/api/demo/workflow';
const actions = new Set([
  'create_order', 'reserve', 'compare', 'approve', 'receive_x', 'receive_y',
  'fulfill', 'replay', 'check_isolation', 'reset',
  'use_ai', 'use_sample', 'compare_ai', 'receive',
]);

function unavailable(message = 'The local Python demo is unavailable. Restart the demo server to restore the fixtures.') {
  return Object.assign(new Error(message), { status: 503, code: 'demo_unavailable' });
}

/** One process owns one disposable session. Only one command is sent at a time. */
export function createPythonDemoWorker({
  python = process.env.WORKFLOW_DEMO_PYTHON || 'python3',
  cwd = repositoryRoot,
  timeoutMs = 10_000,
} = {}) {
  let child;
  let reader;
  let pending;
  let failure;
  let closed = false;
  let queue = Promise.resolve();

  const fail = error => {
    failure ||= error;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
    child?.kill();
  };

  const start = () => {
    child = spawn(python, ['-u', '-m', 'logistics_rules.demo_session'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      if (!pending) return fail(unavailable('The Python demo returned an unexpected response. Restart the demo server.'));
      const operation = pending;
      pending = undefined;
      clearTimeout(operation.timer);
      try {
        const value = JSON.parse(line);
        if (typeof value.ok !== 'boolean' || !value.snapshot) throw new Error('Invalid demo response');
        operation.resolve(value);
      } catch {
        const error = unavailable('The Python demo returned an invalid response. Restart the demo server.');
        operation.reject(error);
        fail(error);
      }
    });
    // stderr is drained, never included in responses (it may contain local paths).
    child.stderr.resume();
    child.on('error', () => fail(unavailable('Python could not start. Install Python 3.11 or newer, then restart the demo server.')));
    child.on('exit', () => { if (!closed) fail(unavailable()); });
    child.stdin.on('error', () => fail(unavailable()));
  };

  const execute = command => new Promise((resolve, reject) => {
    if (closed || failure) return reject(failure || unavailable());
    if (!child) start();
    const timer = setTimeout(() => fail(unavailable('The Python demo timed out. Restart the demo server to restore the fixtures.')), timeoutMs);
    pending = { resolve, reject, timer };
    child.stdin.write(`${JSON.stringify(command)}\n`);
  });

  return {
    request(command, { signal } = {}) {
      const result = queue.then(() => {
        if (signal?.aborted) throw Object.assign(new Error('Demo request cancelled.'), { status: 499, code: 'request_cancelled' });
        return execute(command);
      });
      queue = result.catch(() => {});
      return result;
    },
    close() {
      closed = true;
      fail(unavailable('The local demo server has closed.'));
      reader?.close();
    },
  };
}

/** Vite-only transport; this is neither a production API nor core integration. */
export function workflowDemoMiddleware(options = {}) {
  const factory = options.workerFactory || (() => createPythonDemoWorker(options));
  let worker;
  let closed = false;
  let queue = Promise.resolve();
  let estimates;
  const run = (command, signal) => {
    const result = queue.then(async () => {
      if (closed) throw unavailable();
      if (signal.aborted) throw Object.assign(new Error('Demo request cancelled.'), { status: 499, code: 'request_cancelled' });
      worker ||= factory();
      if (command.action === 'compare_ai') {
        const prepared = await worker.request({ action: 'prepare_ai' }, { signal });
        if (!prepared.ok || prepared.snapshot.recommendation) return prepared;
        if (!options.estimatesFactory) throw unavailable('AI estimates are not configured on this demo server.');
        const state = prepared.snapshot;
        const suppliers = state.suppliers.map(({ id, name }) => ({ id, name }));
        estimates ||= options.estimatesFactory(suppliers);
        const needed = state.lines[0].shortage.quantity_to_purchase;
        const response = await estimates.run({
          request: {
            id: state.order.id, buyerId: 'company-A-demo', createdAt: state.order.created_at,
            maxBudgetCents: state.budget_cents, selectedSupplierIds: suppliers.map(s => s.id),
            items: [{ id: state.lines[0].id, name: state.item.name, quantity: needed, requiredDate: state.deadline, unitLabel: 'filters' }],
          }, suppliers, preference: 'lowest_cost',
        }, { signal });
        if (signal.aborted) throw unavailable('Estimate generation was cancelled. Try again.');
        return worker.request({ action: 'apply_ai', estimates: {
          provenance: response.provenance, assumptions: response.assumptions,
          quotes: response.quotes.map(quote => {
            const offer = quote.items[0];
            if (offer.price.kind !== 'unit') throw unavailable('AI estimates did not provide explicit unit prices.');
            return { supplier_id: quote.supplierId, capacity_quantity: offer.availableQuantity,
              quantity_priced: needed, price_cents: offer.price.cents, currency: 'USD', expected_date: offer.expectedDate };
          }),
        } }, { signal });
      }
      return worker.request(command, { signal });
    });
    queue = result.catch(() => {});
    return result;
  };

  const middleware = async (req, res, next) => {
    if (req.url?.split('?')[0] !== endpoint) return next();
    const send = (status, data) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (!['GET', 'POST'].includes(req.method)) return send(405, { ok: false, error: 'Use GET for demo state or POST for a demo action.' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      return send(403, { ok: false, error: 'Use the local demo application.' });
    }
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try {
      let command = { action: 'snapshot' };
      if (req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
          return send(415, { ok: false, error: 'Send an application/json demo action.' });
        }
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += Buffer.byteLength(chunk);
          if (length > 4096) return send(413, { ok: false, error: 'The demo request is too large.' });
          chunks.push(Buffer.from(chunk));
        }
        try { command = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return send(400, { ok: false, error: 'Send a valid JSON demo action.' }); }
        if (!command || typeof command !== 'object' || Array.isArray(command)
          || Object.keys(command).some(key => !['action', 'key', ...(command.action === 'create_order' ? ['budget_cents'] : command.action === 'receive' ? ['supplier_id'] : [])].includes(key))
          || !actions.has(command.action)
          || ('budget_cents' in command && (!Number.isSafeInteger(command.budget_cents) || command.budget_cents < 0 || command.budget_cents > 100_000_000))
          || (command.action === 'receive' && !['X', 'Y', 'Z'].includes(command.supplier_id))
          || ('key' in command && (typeof command.key !== 'string' || !command.key.trim() || command.key.length > 128))) {
          return send(400, { ok: false, error: 'Send a known demo action and an optional operation key of 1 through 128 characters.' });
        }
      }
      const result = await run(command, controller.signal);
      send(200, result);
    } catch (error) {
      send(error.status || 503, { ok: false, error: error.status ? error.message : unavailable().message, code: error.code || 'demo_unavailable' });
    } finally {
      res.off('close', cancel);
    }
  };
  middleware.close = () => {
    closed = true;
    worker?.close();
    void estimates?.close();
  };
  return middleware;
}
