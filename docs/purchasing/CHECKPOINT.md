# Implementation checkpoint - 28 October 2026

## Current state

- Dennis's setup/CRUD extension is implemented: `/business.html` provides a
  questionnaire, standard entity and employee records, customer order entry,
  and forms generated for user-created tables and fields.
- Real foreign keys enforce relationships; customer-order submission publishes
  demand atomically and freezes submitted documents. Stock and approved purchase
  documents remain outside generic CRUD.
- Migration `202610280001_business_records.sql` is applied to the existing
  free-tier Supabase project, with a private pre-migration backup. Existing
  purchasing, receipt and stock row counts are unchanged.
- Hosted setup is intentionally unanswered: enter your own business details to
  create the standard record tables. No browser-test fixtures were added there.
- Verification: 76 PostgreSQL tests, 17 API tests, 286 JavaScript tests, build,
  and a real local PostgreSQL browser walkthrough passed. See
  `business-verification-2026-10-28.md` and `business-workspace.md`.

- Branch: `feature/purchasing-stock-integration`; implementation commit `99278ac`.
- Existing free-tier Supabase project is connected and initialized.
- Both tested SQL migrations are applied; business identity, checksums, and private schema access are verified.
- A private pre-migration business-schema backup is saved in ignored `.local-planning/backups/`.
- Explicit synthetic demo bindings/demand were seeded.
- Supabase-backed browser verification passed: purchase 1 approved, receipts 3 + 8, total received 11, outstanding 0, on-hand/reserved 15/15.
- Detailed evidence: `verification-2026-10-28.md`.
- Database URL and owner development token remain in ignored `.env.local`. Never print or commit them.

## Local runtime

The API and Vite frontend were started for verification:

- API: `http://127.0.0.1:8001`.
- Purchasing page: `http://127.0.0.1:5173/purchasing.html`.
- Setup and records: `http://127.0.0.1:5173/business.html`.
- Enter `LOGISTICS_API_TOKEN` from `.env.local` to connect. It is kept in browser memory only.

If these servers are no longer running, restart from the LogisticsNerd repository:

```sh
.venv/bin/python -m uvicorn logistics_persistence.api:app --host 127.0.0.1 --port 8001 --env-file .env.local
```

In another terminal:

```sh
npm run dev
```

Do not reset the ledger to repeat the demo. The existing order is fully received but not shipped. Add a new trusted fixture demand for another purchasing cycle.

## Completed implementation and checks

Persistent purchasing, PostgreSQL stock port, whole-delivery receiving, shared command registry/transactions, supplier history, private-database identity, owner-development API, purchasing UI, migrations, backup/restore, and function inventory are implemented in LogisticsNerd.

Previous local evidence: 57 PostgreSQL acceptance tests, 10 HTTP tests, 79 existing Python tests, 286 JavaScript tests, build and browser checks passed. Current remote verification covers approval without stock changes, partial receiving, explicit allocation totals, safe retries, altered-content rejection, persistence and private schema access.

## Remaining integration work

- Confirm authoritative OperationsNerd item/entity/field-role mappings.
- Replace the owner-development authentication adapter with the agreed production host identity/routing.
- Define approved PO amendments, automatic multi-demand cost sharing, carrier/label integration, and any real legacy SQLite data import.
- Feature branch is pushed to `origin/feature/purchasing-stock-integration`. Automatic Supabase deployment is not configured; pushing source code does not itself connect the GitHub deployment integration. Keep one migration authority.

All implementation stays in LogisticsNerd. OperationsNerd remains a reference. Keep the existing free-tier project and local acceptance databases; no paid branching/PITR or extra hosted projects are required for this development setup.
