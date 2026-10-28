# Purchasing and stock implementation plan

Prepared: 27 October 2026.
Status: initial purchasing/stock implementation completed locally on 27 October. Supabase connectivity verified; remote migration not yet applied. See CHECKPOINT.md for the exact resume point and actual checks.

## 1. Workspace and agreed target

- All implementation, PostgreSQL porting, migrations, tests, configuration, and new documentation belong in this LogisticsNerd repository.
- Work branch: `feature/purchasing-stock-integration`.
- Parent: `feature/standalone-workflow-rules`, commit `412de0ad7b0d0e84774d883e0ce3505bda467e4d`.
- OperationsNerd is a read-only integration reference after the requested update to main `4ac00e6`.
- Its original untracked documentation was preserved in stash `0394759` (`codex/pre-update-operationsnerd-2026-10-27`); 64 files were saved. Do not apply, drop, or change that stash as part of implementation here.
- User decision: plan a coordinated PostgreSQL migration for purchasing and stock. Do not leave purchasing in PostgreSQL while authoritative stock remains in SQLite.
- Development target: Supabase project `cxwxpmspmjgpipxdjhgx`, endpoint `https://cxwxpmspmjgpipxdjhgx.supabase.co`.
- Planning assumption: this project represents one business's development database. Every other business needs its own private business database. Git branches are development environments, not business identity boundaries.
- Separate source repositories do not require separate runtime databases. Purchasing and stock for the same business run against the same PostgreSQL database and transaction infrastructure.
- Keep platform/core mappings behind explicit adapters. No changes to the OperationsNerd checkout are part of this implementation.

## 2. Evidence and current implementation

All four supplied PDFs were read in full, 26 pages total:

| Source in the parent folder | Pages | Relevant evidence |
| --- | ---: | --- |
| OperationsNerd update email chain | 16 | 32 messages; private databases; purchasing ownership; schema review; October 26 standard-entity and temporal-history decisions. |
| Branch-notes email chain | 4 | 7 messages; exact receiving APIs; allocation gap; whole-delivery proposal; key convention; shipment states. |
| Splitting-the-work email chain | 2 | 3 messages; Soma owns buying, Jasmeet owns stock; receiving is the handoff. |
| My OperationsNerd branches: what each one is for | 4 | Four branch purposes, implemented stock capabilities, record-links prototype status, unstable field-role mappings. |

Code references inspected:

- LogisticsNerd `412de0a`: `logistics_rules/selection.py`, `repository.py`, `workflow.py`, demo transport, tests, and standalone documentation.
- OperationsNerd main `4ac00e6`: core database schema, entity/spec records, authentication boundary, and migration/backup behavior.
- OperationsNerd stock branch `origin/jasmeet/logistics-stock` at `68554a1`: `modules/logistics/stock.py`, `schema.sql`, README, and API contracts.
- Record-link branch at `0a873e3`: evidence prototype, not an integrated migration foundation.
- October 23 schema proposal preserved in the OperationsNerd stash; it remains design evidence, not runtime code.

Important differences between decisions and code:

| Area | Current code | Target |
| --- | --- | --- |
| LogisticsNerd persistence | In-memory fixture repository | Durable PostgreSQL purchasing and stock. |
| Purchasing model | PO combines header/line and belongs to one customer line | Separate headers, lines, quote versions, and many-to-many purchase allocations. |
| Receiving | Local demo edits a mutable balance and receives a whole PO | Stock-owned immutable receipt/movement records, partial receipts, atomic whole delivery. |
| Stock integration | No persistent adapter | Port the existing stock engine into this repository and integrate through one contract. |
| Core tenancy | Main still uses one shared SQLite file | Host must supply the correct private business database; current core routing remains an external integration dependency. |
| Whole-delivery API | Not in the inspected stock branch | Implemented and tested multi-line receipt transaction with explicit allocation links. |
| Shipment reporting | Stock reports three states | Proposed five derived states; update the guide explicitly when adopting this change. |
| Core item identity | Numeric record IDs and generated type/field keys exist | Amaan still needs to confirm semantic item/entity bindings. |
| Command keys | Stock registry covers stock commands only | One enforced registry across purchasing and stock. |
| Migrations | SQLite schema initialization; standalone backup utility | One versioned PostgreSQL migration history and tested import/backup/restore procedure. |

The October 21 documents in `docs/standalone/` describe the earlier shared-database, whole-receipt demo. This plan supersedes their conflicting integration assumptions. Preserve historical verification records as evidence of that older scope.

## 3. Decisions to preserve

1. Soma owns quotes, supplier comparison/selection, PO headers/lines, and purchase allocations. Purchasing initiates the receiving handoff.
2. Jasmeet's stock implementation is the behavior baseline for movements, reservations, receiving, lots, shipments, and tracking. The PostgreSQL port is implemented here without creating a second authoritative ledger.
3. Purchase orders remain separate from customer orders.
4. Approval freezes supplier, currency, line terms, and allocations under Soma's current proposal. It does not add stock. An amendment/cancellation process needs an explicit definition; do not silently edit approved records.
5. The schema supports split sourcing and partial receipts. The first purchasing UI selects one supplier per shortage.
6. Each exact quote version can be converted into at most one PO line. A new quantity or changed terms requires a new offer version.
7. One request key identifies one logical command within one private business database. Matching retries return the saved result; altered command/content fails. Failed transactions save no successful result.
8. Receipts and reservations for a whole delivery succeed together or roll back together. PO/allocation received quantities are derived from explicit stock receipt records.
9. Standard entity tables plus chat-defined extra fields were approved by Dennis on October 26. The core mapping remains unconfirmed; approval does not justify a duplicate catalog.
10. Supplier history must retain old values. Use a stable supplier identity with retained revisions/validity intervals, and preserve the exact approved supplier revision or snapshot on the PO. Coordinate the core representation rather than inventing parallel master records.
11. Five shipment states are draft, dispatched, in_transit, delivered, and exception; delivered is terminal. The guide currently stores status. Adopting event derivation remains an explicit design change in this plan.
12. One customer order per shipment is the initial rule. Broader professor requests such as transfers, returns, and damage processing remain visible in the function inventory and with stock ownership; they are not silently included in the first purchasing milestone.

## 4. Implementation sequence

### Phase A: Contracts and updated function map

Deliver the complete combined function/read/write/owner/status map before schema implementation. Include explicit standard-entity create/read/update/archive-or-delete operations, supplier revision history, and CRUD of configured extra fields. Also inventory customer order headers/lines, shipment headers/lines, carrier options, inventory by location, damage/expiry adjustments, and transfers. Mark ownership and implementation milestones rather than assigning every operation to purchasing. Section 5 below is only the initial purchasing inventory.

Record terminology, table naming, identifier format, money and quantity units, approval/amendment rules, and schema migration conventions. Define the professor's line-item date requirement explicitly: distinguish order date, required date, receipt date, and shipment date rather than silently selecting one meaning.

Define an injected core adapter for item, supplier, customer, order-line, actor, location, and field-role lookup. Keep fixture bindings explicitly test-only until the authoritative core mapping is confirmed. Reject missing or wrong-type references instead of inferring identity from display names.

Specify the whole-delivery request and result. Its conceptual input contains a stable delivery identity, request key, receipt portions with PO-line/item/location references, optional lot/expiry data, and explicit allocation/customer-line splits. Its result exposes stable delivery, portion, movement, reservation, and allocation identifiers. The exact Python signature is not already agreed or implemented.

Specify which component enforces approved PO status, item compatibility, PO remaining quantity, allocation remaining quantity, and matching customer lines. These checks must run inside the same transaction as stock writes. Reading limits before invoking a command that starts another transaction is insufficient.

Propose a deterministic cost-sharing rule for one PO line serving several customer lines. The October 23 guide proposes quantity-proportional minor-unit allocation with deterministic remainder distribution; team agreement is still needed before using that rule for approval budgets.

### Phase B: PostgreSQL and migration foundation

Create `supabase/config.toml`, ordered SQL migrations under `supabase/migrations/`, environment templates, a local PostgreSQL test setup, and a Python PostgreSQL adapter. Candidate driver: Psycopg 3; pin a supported release during implementation.

One shared unit of work owns BEGIN, COMMIT, and ROLLBACK for both modules. Public commands enter that boundary; internal purchasing and stock helpers never commit independently.

Create one durable request registry with a unique request key, operation, versioned canonical payload identity, saved result, and audit timestamps. Both modules must use it. Two separately unique tables do not enforce the cross-module convention.

A whole-delivery command creates several rows. Give child rows stable identifiers and uniqueness within the enclosing command/receipt. Porting the current movement-level `UNIQUE(idempotency_key)` unchanged would prevent several movement rows under one logical request.

Replace SQLite-specific placeholders, row IDs, date functions, PRAGMA statements, BEGIN IMMEDIATE, RAISE syntax, triggers, and views. Preserve database-enforced immutability and relationship checks.

Replace SQLite's single-writer assumption with a documented PostgreSQL lock order. Lock relevant PO/allocation rows and stable item/location resources before reading contested quantities. Lock lots/reservations/shipments consistently. A resource lock row may coordinate writers but must not become an editable inventory balance. Include all write paths in the locking/permission design. Use bounded whole-command retries where serialization/deadlock handling requires them, preserving the original request key.

Integrate migration history with backup/precheck/restore. Supabase migration deployment does not by itself establish the application's automatic backup or legacy-data validation policy.

### Phase C: Port the stock baseline in this repository

Bring the pinned stock source/tests into a reviewed PostgreSQL port with source provenance. Preserve the existing SQLite baseline for parity checks in disposable test databases, rather than editing the OperationsNerd checkout.

Port and verify immutable movements, opening stock, reservations/releases, partial shipments, lots/expiry/holds, shipment dispatch, and tracking. Distinguish stock lot allocations from purchasing allocations; they are different relationships.

Provide core-reference validation through the agreed adapter/local mappings. The existing stock branch accepts integer item IDs and string references without authoritative purchasing foreign keys; that is not sufficient validation for the integrated module.

Adopt the five-state event-derived view in this port as a documented design change, subject to the schema decision. Tracking events do not alter stock, and delivered remains terminal.

### Phase D: Persistent purchasing

Reuse deterministic selection, price, currency, expiry, budget, and frozen-term logic from `logistics_rules/selection.py` and `workflow.py` where compatible. Preserve the current solver's documented bounds; do not describe it as unbounded optimization.

Implement immutable supplier quote versions, PO drafts/headers/lines, explicit purchase allocations, approval audit, and read projections. Allow one demand to use several PO lines and one PO line to supply several demands. Avoid uniqueness constraints that force one supplier per customer line.

Approval revalidates authorization, expected document version, quote validity, supplier/item/currency compatibility, exact quoted quantity, budgets/deadlines, and uncovered demand under the transaction lock. Freeze approved terms and save the replay result atomically. Stock is unchanged.

Use the mapped supplier revision history for changes such as addresses. Standard fields and chat-defined extra fields remain accessible through the core contract. Do not build a second production supplier/item/customer catalog.

### Phase E: Whole-delivery receiving and purchase projections

Implement the new whole-delivery stock command in this repository against the shared PostgreSQL runner. Validate the purchase limits inside its transaction, then write one delivery header, receipt portions, explicit purchasing-allocation links, movements, and reservations.

One receipt can reserve for several waiting customer lines. Totals of the received portions must equal the physical quantity, with no duplicate stock posting. Retain simple single-line commands through the same runner.

Derive PO outstanding quantity from ordered quantity minus accepted receipt portions. Derive allocation received quantity from explicit links. Purchasing adds no second stock balance and needs no redundant receipt-time status/counter write.

Use stable physical delivery identity in addition to request replay identity. A new request key does not by itself prove different goods arrived. Permit multiple legitimate partial receipts for the same PO line; `source_ref` is not a globally unique receipt identifier.

### Phase F: API, UI, and core adapter packaging

Add a Python API compatible with the core's trusted-context contract. The existing Vite fixture worker is not production authentication or durable storage.

Keep business selection and authorization on the backend. Resolve the private database before looking up local IDs or replay results. The browser must not choose arbitrary database paths or create authority by supplying an actor ID.

Keep the existing frontend and supplier comparison usable. Add quote versions, PO drafts, allocation display, explicit approval, a delivery form, and purchasing progress. Maintain the single-supplier initial UI while exercising supplier splits through domain/integration tests.

All privileged mutations go through the transactional backend. Do not expose raw ledger writes through browser CRUD. Review Supabase API exposure, roles, and policies so they cannot bypass the module commands. Supabase database use does not require replacing core authentication with Supabase Auth.

Package the purchasing/stock/core boundary so it can later be consumed by OperationsNerd without code changes to that checkout during this project.

### Phase G: Migration rehearsal, acceptance, and cutover

Start with a disposable single-business PostgreSQL database. Current LogisticsNerd purchase data is ephemeral; no persistent purchasing database has been found to migrate.

For any real SQLite stock/core data supplied later, work from a consistent backup/copy. Precheck references, ownership, keys, quantities, temporal records, and ledger totals. Preserve IDs or record explicit mappings, including old request/result identities. Conflicting request histories must stop import, not be silently merged.

Reconcile movement totals, outstanding quantities, reservations, lot balances, frozen PO terms, and shipment history after import. Never invent historical movements from an editable balance. If only a balance exists, require a reconciled opening movement and retain the source evidence.

Test backup restoration and failed migration rollback. Cut over purchasing and stock together; do not run independent SQLite and PostgreSQL stock writers for the same business. Rehearse failback before allowing new PostgreSQL writes.

## 5. Initial purchasing function/read/write map

Names below are logical contracts, not existing API signatures or approved final table names. New persistent implementations remain proposed until implemented and tested.

| Function | Reads | Writes | Responsibility/status |
| --- | --- | --- | --- |
| Resolve standard entity / historical supplier revision | Core mappings, standard fields, revisions, configured extra fields | Core-owned entity history only through agreed adapter | Core contract dependency; adapter implemented here. |
| Save or revise quote | Supplier/item bindings, customer need, quote versions | New immutable quote version; shared request result | Purchasing; new persistent implementation. |
| Compare suppliers | Valid quote versions, demand, reservations/inbound coverage, budget/deadline | Optional saved comparison; never an approved PO | Purchasing; reuse deterministic comparison logic. |
| Create or edit draft PO | Supplier/item bindings, quotes, draft version | PO header/lines, draft version, shared request result | Purchasing; proposed. |
| Assign purchase allocations | PO lines, customer lines, current commitments | Purchase allocation rows, shared request result | Purchasing; proposed many-to-many model. |
| Approve purchase | Draft, quotes, supplier revision, allocations, stock/commitment projections, actor | Frozen approval/terms, audit, shared request result; no stock | Purchasing; reusable rules plus new persistence. |
| Read purchase progress | Approved PO lines, stock receipt portions and explicit allocation links | None | Purchasing projection; proposed. |
| Receive whole delivery | Approved purchase limits, identity mappings, stock/lot resources | Stock receipt header/portions/links, movements, reservations, shared request result | Purchasing initiates; coordinated stock implementation here. |
| Receive or receive-and-reserve one portion | Same permitted source/quantity checks, stock resources | Stock receipt/movement/reservation and shared result | Port existing stock behavior. |
| Dispatch / record tracking | Shipment, reservations, events | Stock dispatch/movements or tracking events, shared result | Stock port; tracking changes no stock. |
| Manage customer orders, carriers, locations, damage/returns/transfers | Core/stock contracts | Appropriate core/stock records | Include in combined team function inventory; not automatically purchasing ownership or first-slice scope. |

Approved PO amendments/cancellation need a separate policy before exposing them as implemented functions. Retained history and compensating stock events take precedence over destructive deletion of approved/posted records.

## 6. Supabase and GitHub setup

The project URL identifies the API endpoint. It is not a PostgreSQL connection string and does not provide database or management authorization.

Implementation setup:

1. Repair/update the local Supabase CLI if necessary: the installed binary was terminated even for `--version` during this review.
2. Obtain the project's real connection details from Dashboard > Connect. Use a direct connection or session pooler as appropriate for the backend/migration runtime; copy the actual host rather than guessing its region.
3. Store the backend connection string in an ignored environment file/secret store. No database password, management token, or service-role credential belongs in browser code, Git, the plan, or a chat message.
4. Initialize/version the local `supabase/` configuration and migrations in this repository. Link the CLI to project ref `cxwxpmspmjgpipxdjhgx` when authenticated.
5. Inventory any remote schema first; do not overwrite an existing project or apply speculative migrations.
6. Test migrations locally and on a disposable development target before pushing schema changes remotely.
7. For GitHub automation, authorize the Supabase GitHub integration and select `somadisingh/logisticsnerd`. Working directory is `.` if `supabase/` is at the repository root.
8. The new feature branch currently exists only locally. GitHub cannot watch it until it is pushed. No push, PR, GitHub integration change, or remote migration was performed in this preparation task.
9. Choose the deployment branch deliberately. A feature branch must not accidentally become the production deployment source. Optional Supabase preview branching has separate plan requirements; do not enable a paid feature automatically.
10. One shared cloud project with business_id/RLS-separated rows would change the agreed physical business-isolation model. Additional businesses require an explicit private-database provisioning/routing strategy.

Native Supabase GitHub integration and a repository-owned CI deployment are alternatives. Choose one migration deployment authority so both do not race to apply the same changes.

## 7. Acceptance criteria

Run new database tests against real PostgreSQL with independent connections, not only mocks or process-local locks.

- Purchasing approval creates no stock, freezes exact approved terms, and survives a restart.
- Quote version conversion is unique; expired, mismatched, changed-quantity, overbudget, or late quotes are rejected without residual writes.
- One customer line can use two suppliers; one PO line can serve several customer lines.
- Partial receipts update derived PO/allocation quantities correctly, without editable balance columns.
- A whole delivery can reserve for several customer lines. A failure on any line rolls back all delivery writes and its successful-result record.
- A committed request whose response is lost replays the same IDs/result. Changed content or another command with the same key fails across both modules.
- Two requests racing for the final stock units cannot both reserve them. Two receipts racing for the last receivable PO/allocation quantity cannot both succeed.
- Whole-delivery child rows can share their enclosing command without violating mistaken row-level key uniqueness.
- Lots, expiry, holds/recalls, reservation/shipment consistency, immutable movements, dispatch-once behavior, and tracking-without-stock retain parity with the stock baseline.
- Late tracking events do not reverse delivered. Test all five proposed reported states when that change is adopted.
- Supplier address changes retain prior revisions and valid-time queries; old approved POs retain their original supplier facts.
- Private business databases permit identical local IDs and request keys independently. Unauthorized database selection is rejected before record/replay lookup.
- Reproduce the 15-chair walkthrough: opening 4, purchases A6+B5, partial receipts, shipments 6 and 9, and delivery confirmations with no extra stock effect.
- Backup, precheck, migration failure, import reconciliation, and restore pass on disposable copies.
- Existing demo tests/build remain passing, or intentional behavior changes are explicitly documented with replacement evidence.

## 8. Dependencies and sequencing

No further user preference is needed to prepare this plan. Implementation must still resolve external contracts rather than invent them:

- Amaan/core: authoritative item and standard-entity mapping, semantic field roles, authenticated business context, and future host database routing.
- Coordinated stock contract: exact whole-delivery payload/result, allocation links, limits inside the transaction, and common request registry.
- Product policy: approved allocation amendments, multi-demand cost shares, and explicit adoption of event-derived shipment status.
- Supabase operator: authenticated project access, server-side connection details, and GitHub authorization when enabling remote deployment.

Start with Phase A and the local PostgreSQL foundation. Core mapping can be represented by a test adapter while work proceeds, but production entity linkage and integrated deployment cannot be claimed complete until those contracts are resolved.

## 9. Preparation checks actually run

- Four PDFs: all 26 pages read; rendered pages inspected by the PDF review agent.
- Git: OperationsNerd fast-forwarded to `4ac00e6`; stash preserved. LogisticsNerd branch created from the exact current feature HEAD.
- `python -m unittest discover -s tests_python`: 79 passed.
- `npm test`: 286 passed across 9 files.
- `npm run build`: TypeScript and Vite passed. Existing future Vite configuration warnings remain.
- No PostgreSQL migration, stock-port test, database import, production authentication test, or live Supabase connection was executed. Those are implementation acceptance work.

## 10. Official technical references

- [Supabase PostgreSQL connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase GitHub integration](https://supabase.com/docs/guides/deployment/branching/github-integration)
- [Supabase deployment and optional preview branching](https://supabase.com/docs/guides/deployment)
- [Supabase as a standalone dedicated PostgreSQL database](https://supabase.com/kb/faqs/database/standalone-postgres-database)
- [Psycopg transaction management](https://www.psycopg.org/psycopg3/docs/basic/transactions.html)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
