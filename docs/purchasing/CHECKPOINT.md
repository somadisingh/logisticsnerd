# Implementation checkpoint - 27 October 2026

Stopped at the user's request to conserve remaining hourly usage.

## Completed locally

- Branch: feature/purchasing-stock-integration; based on feature/standalone-workflow-rules at 412de0a.
- PostgreSQL purchasing: immutable quote versions, draft PO headers/lines, many-to-many allocations, approval audit/frozen terms, explicit cost shares, supplier comparison and progress.
- PostgreSQL stock port: immutable ledger, reservations, lots/expiry/holds/recall, partial shipment, five derived shipment states, and atomic whole-delivery receiving with explicit purchase-allocation links.
- Shared durable cross-command request registry, transaction runner, resource locks, PO/allocation receipt limits, and versioned SQL migrations.
- Trusted core-reference projection seam and supplier validity history; real OperationsNerd core mapping remains external.
- Owner-protected local API and separate purchasing page, with no credentials in browser configuration or local storage.
- Business-schema backup and empty-target restore, migration identity/checksum validation, repeatable explicit demo fixtures.
- Setup instructions, function inventory, database contract, pinned upstream stock fixture/provenance.

## Actual checks

- 57 real PostgreSQL tests passed, including concurrent connections, full delivery rollback, 15-chair fulfillment, API integration, backup/restore, private database isolation, and three SQLite/PostgreSQL parity checks.
- 10 HTTP boundary tests passed.
- Existing 79 Python tests and 286 JavaScript tests passed.
- TypeScript/Vite build passed.
- Full browser purchasing flow passed at desktop and 390px mobile widths; no horizontal overflow or JavaScript errors.
- Supabase read-only connection check succeeded: PostgreSQL 17.11, zero public tables, no logistics schema.

## Remote state

NO Supabase migrations, seed writes, paid features, additional projects, or GitHub changes were performed.
The connection string and generated local API token are in ignored .env.local; do not print or commit them.
The existing free-tier project is the single-business development target.
OperationsNerd was not changed during implementation; its prior requested pull and saved documentation stash remain as recorded in the implementation plan.

## Resume here

1. Review the local diff and these checkpoint notes.
2. Run the migration CLI against the configured development project. It makes a private business-schema export before applying the tested SQL:
   .venv/bin/python -m logistics_persistence.migrate
3. Explicitly seed synthetic development bindings/demand:
   .venv/bin/python -m logistics_persistence.seed --demo
4. Verify remote schema/identity and demo state without displaying credentials.
5. Start the API:
   .venv/bin/python -m uvicorn logistics_persistence.api:app --host 127.0.0.1 --port 8001 --env-file .env.local
6. Start npm run dev; open /purchasing.html and enter the owner development token from the local file.
7. Verify the Supabase-backed browser flow. GitHub push/deployment integration is still separate and not configured.

Core item/entity mapping, production authentication/routing, approved PO amendment policy, automatic multi-demand cost sharing, carrier integration, and legacy SQLite data import remain explicit future work. Current actor/bindings are development projections, not completed OperationsNerd integration. Use only the existing free Supabase project and local tests; paid branching/PITR are not required.
