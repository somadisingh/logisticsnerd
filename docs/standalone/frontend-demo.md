# Local order workflow demo

The browser demo uses the main branch's fonts, colors and layout components with the actual standalone Python rules. The original supplier comparison is preserved at `/supplier-comparison.html`; its comparison and estimate-cache logic is unchanged.

This is one disposable, in-memory demo session with synthetic supplier data and fixed fixture identities. It does not connect to OperationsNerd, a database, real authentication, supplier services or accounting. The original approval gates for persistent integration remain in place.

## Run

Requirements: Python 3.11+ on `PATH` as `python3`, and a supported Node.js version from `package.json`.

```sh
npm ci
npm run dev
```

Open the local address Vite prints, normally `http://127.0.0.1:5173/`. No API keys or Redis instance are needed for the order demo. To choose a Python executable, set `WORKFLOW_DEMO_PYTHON=/absolute/path/to/python3` when starting Vite. `npm run build` and `npm run preview` also support the local demo; serving `dist/` as static files alone does not run the Python worker.

All tabs connected to this server share the demo session. Reloading the page reads its current state. **Reset demo** discards the session and restores synthetic fixtures; it is not a cancellation or reversal of a real stock movement. Restarting the server also clears the session. Restart Vite after editing Python source so the worker imports the new code.

## Demo walkthrough

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

Each supplier card distinguishes capacity, priced quantity and purchased quantity. Approved terms retain the synthetic source label and immutable quote snapshot. A stale tab cannot replace an approved supplier plan by comparing again after approval.

The browser exposes the requested single-item scenario. Multi-line orders, incompatible duplicate constraints, other quote failures and competing operations are exercised by Python tests, rather than additional demo screens.

## Implementation boundary

- `src/workflow-demo.ts` renders server snapshots and sends explicit actions. It does not implement inventory or supplier-selection rules.
- `src/workflow-client.ts` provides typed local requests, bounded error messages, timeout handling and response checks.
- `server/workflow-demo.mjs` supplies Vite-only `/api/demo/workflow`, validates bounded JSON commands and serializes requests to one Python worker. The API accepts action names and optional operation keys; it accepts no client company, item, owner or arbitrary record IDs.
- `logistics_rules/demo_session.py` owns fixed fixtures and invokes `Workflow`. Fixture previews and actual quotes come from one Python definition. The worker communicates using newline-delimited JSON; no Python HTTP framework or new dependency is required.
- Existing `workflow.py`, `repository.py` and `selection.py` remain independent of the browser and transport.

Operation keys apply to business commands: create, reserve, approve, receive and fulfill. Compare publishes fixed immutable estimate fixtures and performs a query. Reset and the replay/isolation checks are demo controls, not new domain operations or a durable production API. The existing in-memory journal still provides business-command replay and event guards.

## Verification

```sh
python3 -m unittest discover -s tests_python -v
npm test
npm run build
```

Final automated and browser results are recorded in [frontend-verification.md](frontend-verification.md). Tests exercise the real Python worker as well as transport and client failures. Browser QA uses a separate headless Edge profile, synthetic actions and the preserved sample-comparison path; it makes no model or supplier requests.
