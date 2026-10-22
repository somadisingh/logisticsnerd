# Local order workflow demo

The browser demo uses the main branch's fonts, colors and layout components with the actual standalone Python rules. The original supplier comparison is preserved at `/supplier-comparison.html`; its default total-price contract and cache keys are preserved. The workflow adds an explicit unit-price mode with separate cache identity.

This is one disposable, in-memory demo session with fixed company/stock fixtures. Choose prepared synthetic supplier terms or Baseten AI estimates. It does not connect to OperationsNerd, authoritative inventory storage, real authentication, suppliers or accounting; Redis stores estimates only. The original approval gates for persistent integration remain in place.

## Run

Requirements: Python 3.11+ on `PATH` as `python3`, and a supported Node.js version from `package.json`.

```sh
npm ci
npm run dev
```

Open the local address Vite prints, normally `http://127.0.0.1:5173/`. No API keys or Redis instance are needed for the prepared sample. AI mode needs the existing server-side Baseten key and configured Redis cache. To choose a Python executable, set `WORKFLOW_DEMO_PYTHON=/absolute/path/to/python3` when starting Vite. `npm run build` and `npm run preview` also support the local demo; serving `dist/` as static files alone does not run the Python worker.

All tabs connected to this server share the demo session. Reloading the page reads its current state. **Reset demo** discards the session and restores synthetic fixtures; it is not a cancellation or reversal of a real stock movement. Restarting the server also clears the session. Restart Vite after editing Python source so the worker imports the new code.

## Prepared sample walkthrough

| Action | What to show |
| --- | --- |
| Reset | 6 on hand, 2 reserved for another order, 4 available. |
| Create order | Customer demands 15 units. No purchase or stock movement. |
| Reserve available stock | Customer receives 4 reserved units; original shortage is 11. |
| Compare suppliers | X covers 7, Y covers 4. Combined price $11.80 USD fits the $20 shortage-purchase budget. No PO exists yet. |
| Approve both purchases | Explicit fixture owner action creates two POs. On-hand remains 6; approved inbound is 11. |
| Receive X's 7 | On-hand becomes 13. Y is still unreceived. **Try fulfillment** rejects the incomplete order and brings the error into view. |
| Receive Y's 4 | On-hand becomes 17; all 15 customer units are reserved. |
| Fulfill order | Deduct 15 once. Final on-hand and reservations are both 2, belonging to the other order. |
| Replay completed actions | Same-key requests return original results. Different keys for completed stock events are rejected. Stock stays unchanged. |
| Check company isolation | Fixture Company B reads/writes against A records are rejected. This is a domain isolation check, not a production authentication test. |

Each supplier card distinguishes capacity, priced quantity and purchased quantity. Approved terms retain their synthetic or AI source label and immutable quote snapshot. A stale tab cannot replace an approved supplier plan by comparing again after approval.

The browser exposes the requested single-item scenario. Multi-line orders, incompatible duplicate constraints, other quote failures and competing operations are exercised by Python tests, rather than additional demo screens.

## AI estimates

Choose **AI estimates · Baseten**, set the shortage-purchase budget before creating the order, reserve available stock, then click **Generate AI estimates**. Source changes reset the fixture session. The model estimates prices/capacity/delivery for three fictional suppliers; Python independently chooses a feasible single or split allocation. No Baseten generation occurs on page load, source changes, reservations, approvals, receipts or fulfillment. A matching valid seven-day cache entry avoids a new generation.

The result displays model, generation/expiry timestamps, cache status and assumptions. The backend requests explicit all-in linear unit prices for the shortage quantity, with separate capacity. Total-price lots from the legacy comparison cannot be prorated into these terms. Budgets/deadlines never influence the generated facts; Python can reject every offer. Reset to change the budget or obtain a new quote set after expiry. Approval revalidates immutable terms against the live UTC clock in AI mode.

See [Baseten workflow verification](baseten-workflow.md) for actual live and cached results. The prepared sample retains its fixed clock and 7 + 4 split.

## Implementation boundary

- `src/workflow-demo.ts` renders server snapshots and sends explicit actions. It does not implement inventory or supplier-selection rules.
- `src/workflow-client.ts` provides typed local requests, bounded error messages, timeout handling and response checks.
- `server/workflow-demo.mjs` supplies Vite-only `/api/demo/workflow`, validates bounded JSON commands and serializes requests to one Python worker. The API accepts action names/keys, an optional integer-cent budget on create, and a selected fixture supplier on receipt; it accepts no client company, item, owner, arbitrary record IDs or generated quote payload. The server constructs AI input from the authoritative in-memory snapshot and alone imports provider output.
- `logistics_rules/demo_session.py` owns fixed fixtures and invokes `Workflow`. Prepared fixture previews and quotes come from one Python definition; AI terms are imported in one atomic quote batch. The worker communicates using newline-delimited JSON; no Python HTTP framework or new dependency is required.
- Existing `workflow.py`, `repository.py` and `selection.py` remain independent of the browser and transport.

Operation keys apply to business commands: create, reserve, approve, receive and fulfill. Prepared comparison publishes fixed terms and performs a query. AI comparison uses the shared Baseten runner and estimate cache, then imports immutable quotes and runs Python selection. Reset and the replay/isolation checks are demo controls, not new domain operations or a durable production API. The existing in-memory journal still provides business-command replay and event guards.

## Verification

```sh
python3 -m unittest discover -s tests_python -v
npm test
npm run build
```

Final automated and browser results are recorded in [frontend-verification.md](frontend-verification.md). Tests exercise the real Python worker as well as transport and client failures. Browser QA uses a separate headless Edge profile, synthetic actions and the preserved sample-comparison path; automated tests make no model or supplier requests. A separate bounded live check is recorded in the AI verification document.
