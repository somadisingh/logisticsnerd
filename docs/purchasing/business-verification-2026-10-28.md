# Business workspace verification — 28 October 2026

The implementation adds the questionnaire, standard entity/customer order entry,
and registered-table CRUD requested by Dennis. Code stays in LogisticsNerd.

## Automated checks

- 76 real PostgreSQL acceptance tests passed, including 19 records tests.
- 17 HTTP-boundary tests passed.
- 286 existing JavaScript tests passed.
- TypeScript checking and Vite production build passed.

Database tests prove that PostgreSQL rejects an orphan reference and deletion
of a referenced supplier even through direct SQL. Typed foreign keys also reject
an item used as a PO supplier. Custom tables use the same CRUD functions as
standard tables. Required/unique/type constraints, stale versions, shared
request keys, audit history and protected operational-table access are covered.
Submitted customer orders publish once, freeze header/lines and roll back all
published demand if a later line fails. Supplier changes retain approved terms;
employee fields cannot grant actor permissions.

## Real browser workflow

An isolated native PostgreSQL database and actual FastAPI server were used with
Microsoft Edge through Playwright. The browser completed setup; created a
supplier, customer, item and employee; entered and submitted a customer order;
and verified its demand on the purchasing API. It then created a custom Repairs
table with a supplier relationship, saved and edited a record, added a field,
and verified persistence. Deletion of the referenced supplier and a nonexistent
reference were rejected. Submitted orders/lines appeared read-only.

Desktop and 390px mobile checks found no JavaScript errors or horizontal page
overflow. Tokens were absent from local/session storage; reload cleared
authorization and reconnect recovered saved data. A separate simulated network
failure check verified reuse of the same request key on retry.

Private browser evidence and scripts are under
`.local-planning/business-verification/` (ignored by Git). None of these
acceptance records were written to Supabase.

## Supabase development migration

Existing data passed a read-only typed-reference precheck. The normal migration
command exported the current business schemas to a private local backup before
applying `202610280001_business_records.sql`.

After migration, existing core-binding, demand, purchasing, allocation, receipt,
movement and reservation counts matched the pre-migration values. The business
catalog and existing purchasing workspace both returned HTTP 200 through Vite.
The `anon` and `authenticated` roles still lack access to the private schema.
The questionnaire remains unanswered so the owner can enter the real setup.

Authoritative OperationsNerd mapping, production authentication/routing and
post-submission amendments/cancellations remain outside this verified scope.
