# Shipping API/UI verification — 30 October 2026

Scope: API and browser interface for the existing PostgreSQL stock engine.
`stock.py`, SQL migrations, cash accounts and OperationsNerd were not changed.

## Automated checks

- 85 real PostgreSQL acceptance tests passed, including nine new shipping HTTP
  integration tests.
- 26 API boundary tests passed, including nine new shipping transport tests.
- All 286 existing JavaScript tests passed.
- TypeScript checking and the Vite production build passed.

Shipping acceptance covers purchase approval and receiving followed by partial
dispatch, quantities already committed to every draft, mixed-order rejection,
canonical order references and local customer details. Same-key replay and
changed-content rejection are tested. Competing HTTP dispatch requests with
fresh keys produce one success and one conflict, with exactly one shipment stock
movement. A failure on a later shipment line rolls back all earlier movements.
Carrier history derives the five states, preserves delivered as terminal and
never changes stock.

## Browser with actual PostgreSQL

Microsoft Edge/Playwright used the actual API on an isolated native PostgreSQL
database. The fixture used local business records for a toy shop, a submitted
six-unit customer order and an approved supplier purchase. No stock was seeded:
six toys were received and reserved through the existing purchasing UI.

The browser created a four-unit shipment and dispatched it. The test deliberately
discarded the successful dispatch response after the server committed. Retrying
the unchanged form reused the same request key and produced one movement.
On-hand and reserved quantities both became two.

A carrier event was saved, then its workspace refresh was deliberately failed.
The page reported that the action was saved. Retrying unchanged reused the event
key, and the history contained one event. Delivery followed by a later exception
kept the shipment delivered without another stock movement.

A second shipment used the remaining two units and a label reference without a
tracking reference. Dispatch and delivery completed the order. Final totals were
six shipped, six delivered, zero on-hand and zero reserved.

Desktop and 390px mobile screenshots were inspected. No JavaScript errors or
horizontal page overflow occurred. Reload cleared authorization; reconnect
recovered the saved shipments and stock totals. Tokens were absent from local
and session storage. A separate simulated-network browser check covered failed
selection rollback, missing references, HTML escaping and duplicate prevention
when a saved line's refresh fails.

Ignored local evidence is under `.local-planning/shipping-verification/`:
`checks.json`, `desktop.png`, `mobile.png`, `run-browser.py` and
`verify-browser.cjs`. Temporary PostgreSQL and API processes were cleaned up.

## Existing configured database

The local API was started with the existing ignored environment configuration.
Read-only shipping workspace/list requests returned HTTP 200 through Vite against
the existing free-tier Supabase project. Unauthenticated access returned 401;
existing business and purchasing reads also returned 200.

No hosted shipments, carrier events or stock movements were created by these
checks. No schema migration, paid feature or external carrier integration was
needed. Production core authentication, automatic labels, amendments and cash
accounts remain separate work.
