# Supabase development verification - 28 October 2026

## Target and preparation

- Repository: LogisticsNerd, branch `feature/purchasing-stock-integration`.
- Implementation baseline: local commit `99278ac`.
- Existing free-tier project: `cxwxpmspmjgpipxdjhgx`, PostgreSQL 17.11.
- Before migration: zero public tables and no `logistics` schema.
- Migration CLI created a private business-schema export before applying either SQL file.
- Both migration files applied atomically; the configured business identity and source checksums were verified afterward.
- Current schema contains 23 LogisticsNerd tables. Anonymous and authenticated browser roles do not have schema usage.
- Backup archive permissions are `0600`; archive listing succeeded. Business exports cover public/logistics, not Supabase Auth/Storage service data.

## Supabase-backed browser workflow

The real frontend at `http://127.0.0.1:5173/purchasing.html` used the owner-protected Python API on port 8001 and the saved session-pooler connection. No database credentials entered the browser.

| Step | On hand | Reserved | PO received | PO outstanding |
| --- | ---: | ---: | ---: | ---: |
| Explicit synthetic development seed | 4 | 4 | 0 | 11 |
| Approve supplier A purchase for 11 | 4 | 4 | 0 | 11 |
| Receive first delivery: 3 | 7 | 7 | 3 | 8 |
| Replay first delivery with its original key | 7 | 7 | 3 | 8 |
| Receive second delivery: 8 | 15 | 15 | 11 | 0 |

Purchase order 1 is approved and fully received. Customer demand is 15 chairs; all 15 are reserved and none has shipped in this browser verification. The stored status `approved` describes purchase approval; received/outstanding quantities are derived from receipt records.

Additional checks passed:

- Unauthenticated workspace access returned 401.
- Receipt replay returned the original receipt rather than posting stock again.
- Reusing the request key with changed quantity returned 409.
- Explicit receipt allocation totals equal 11 received units.
- Reload cleared browser authorization; reconnect showed persisted purchase/receipt data.
- No JavaScript errors or 390px horizontal page overflow.
- Owner token was absent from localStorage.
- Desktop and mobile screenshots were visually inspected.

Raw verification records and screenshots are in ignored `.local-planning/purchasing-supabase/`; no credential values are included in these result records.

## Earlier local evidence retained

The implementation checkpoint already recorded 57 real PostgreSQL acceptance tests, 10 HTTP boundary tests, 79 existing Python tests, 286 JavaScript tests, a successful build, and SQLite/PostgreSQL parity. This resumption changed no application code, so it verified the new Supabase target rather than repeating those unchanged local suites.

## Scope and limits

All source changes remain in LogisticsNerd. OperationsNerd was untouched during this resumption. No paid features, additional hosted projects, preview branches, or GitHub changes were made. No real supplier was contacted.

Core bindings, supplier offers, actor, and customer demand remain explicit synthetic development fixtures. Production OperationsNerd item/entity mapping, authentication/routing, amendment policy, carrier integration, and legacy-data import are still separate dependencies.

The seed command is a replay-safe initializer, not a reset: rerunning it preserves the existing fulfilled receiving example and does not erase movements. A new demonstration cycle requires a new trusted test demand rather than deleting ledger history.
