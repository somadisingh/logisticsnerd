# Proposed module contract and minimal integration plan

Review proposal only, 21 October 2026. The current user prompt is **not approval** to apply shared-database migrations or connect the backend/UI. Integration is gated on explicit agreement on item/stock mapping, company isolation, module interface, and split-sourcing scope. Accounting ownership must also be resolved before accounting integration is claimed.

The implemented deliverable is reusable Python rules with an in-memory repository, deterministic tests, and synthetic supplier data. It is not a persistent integrated workflow. No OperationsNerd code is imported by the standalone module.

## Verified platform to target later

The local OperationsNerd checkout is `622d8d7`; it has legacy `/ui` and unprefixed routes. Fetched `origin/main` at `dbff470` was read without pulling over the dirty checkout. The following interfaces exist at fetched `dbff470`:

- `/app` is mounted by `operations_nerd/main.py:43–44`; production keeps authenticated `/api` and removes the unauthenticated legacy surfaces (`55–69`). The `/api` prefix is defined in `agentic/routes.py:17`.
- `agentic/auth.py:191–199` resolves the authenticated account. `agentic/store.py:69–84` resolves an owned business; `176–182` resolves owned proposals.
- `db/db.py:41–57` enables foreign keys and wraps commit/rollback. `agentic/records.py:191–225` shows `BEGIN IMMEDIATE` before read/check/write for SQLite write races.
- `agentic/chat.py:317–348` demonstrates explicit proposal approval, pending/base-version checks, deterministic revalidation, status compare-and-set, and approver audit. These are reusable conventions, not an existing purchasing API.
- `documentation/CONTRIBUTING.md:73–74` and `documentation/agentic_crm_architecture.md:196–211` put reusable logistics rules in `modules/logistics/`, with no core imports. The module interface and shared parties/items/accounting are not built. The database direction is shared storage.

Source inspection is not verification of a running deployment. A future integration branch must establish an agreed updated OperationsNerd baseline while preserving its existing local documentation.

## Proposed contract

The core resolves authentication, company ownership, IDs, currency configuration, and a transaction. The module supplies deterministic logistics validation and state changes. The module must not resolve cookies, call an LLM, execute HTTP requests, generate per-company code, or own a second item/stock authority.

Proposed host boundary, to agree before implementing an adapter:

| Host capability | Responsibility |
| --- | --- |
| Trusted context | Authenticated account/owner, resolved business/company ID, permission to approve, configured v1 currency, and server time. A client business selector is checked against session ownership; client actor/company claims never create authority. |
| Identity resolver | Map customer/supplier/item references to approved core namespaces and preserve IDs. Reject missing, archived/ineligible, wrong-type, or wrong-company links. Unconfirmed mappings return a dependency error instead of creating duplicate core data. |
| Repository and unit of work | Fetch/save company-scoped aggregate state and authoritative stock under one transaction, with durable operation keys and guarded business-event completion. |
| Estimate input | Convert existing comparison output into typed immutable estimate terms with provenance, priced quantity, capacity, currency, price, delivery date, generated time, and expiry. Missing terms are errors, not inferred supplier promises. |
| Approval presentation | Show proposed supplier quantities, combined price, deadline/budget checks, estimate source, impact on demand, and approver action. A recommendation cannot create a PO. |
| Result presentation | Return validated state, immutable purchase terms, factual failure reasons, and original replay result. Describe readiness and stock changes using persisted state. |

Conceptual commands are create/reserve a multi-line order, inspect shortage/readiness, compare/save a sourcing proposal, explicitly approve selected purchases, receive a whole PO, and fulfill a whole customer order. Exact Python call signatures and API paths are to be settled against the standalone public API; this table is a proposed module boundary, not an existing OperationsNerd interface.

For v1, use one company stock location, integer quantities in the approved item unit, and one explicitly configured currency. Split sourcing is supported by standalone rules/tests. Production enablement requires explicit scope approval; an agreed single-supplier deferral must be recorded if chosen instead. Partial receipt/shipment, returns, cancellation, location transfer, fleet/routing, live supplier/carrier services, and full accounting are outside this contract and must fail explicitly.

## Isolation requirements

Every read, mutation, related-record lookup, quote selection, receipt, and approval uses the resolved company context. Authorization occurs before operation replay lookup, so a cached command result cannot disclose another company's records. Check same-owner/different-business cases as well as different-account cases.

Proposed database defenses include `business_id` on every new company-owned table, `UNIQUE(business_id, id)` parent keys, `UNIQUE(business_id, sku)` for any approved catalog proposal, and composite foreign keys containing `business_id`. A PO must reference a quote for the same business **and order line**, not merely a valid quote and a valid line independently. If legacy contacts need a company-qualified candidate key, propose that core prerequisite separately. Generic CRM identities additionally require the approved entity type; an arbitrary `entities.id` is insufficient.

Existing EAV links are app-validated in fetched `dbff470`, and the broader relational link/company migration is not implemented. Do not claim database enforcement across the entire core from the new module proposal.

## Transaction and replay contract

Proposed durable operation identity is `(business_id, operation_key)`, matching the standalone contract. Include command kind and every behavior-relevant input in a canonical, versioned, type-sensitive payload fingerprint, with the original result stored in the authoritative database. Same key and payload returns that result; the same key with a different command or payload fails. Do not silently bind a newly generated timestamp into an otherwise identical retry's input. Revalidate current authorization before returning any result. Failed transactions store no successful operation result; the standalone contract permits retry after correcting a failed request.

Different keys cannot replay the same completed business event: an already received PO must not post stock again; an already fulfilled order must not deduct again; a quote/purchase approval cannot create duplicate coverage. The adapter should return the existing completed event result where permitted by the agreed command contract, or a specific conflict, while leaving balances unchanged.

The eventual persistent adapter must atomically:

1. Resolve ownership and related records under the trusted company context.
2. Claim/check the durable operation key and compare payload fingerprints.
3. Read authoritative on-hand stock, active unfinished-order reservations, and explicit approved inbound allocations using concurrency-safe checks.
4. Revalidate demand, remaining shortage, quote validity, currency, quantities, supplier capacity, deadlines, and cumulative line procurement budget at approval. Recheck approver ownership; approval posts no physical stock.
5. Update stock and reservations together with PO/order lifecycle state, completion timestamps, and the operation result. Receipt exchanges that PO's inbound coverage for physical reserved stock once; fulfillment consumes the order's reserved stock and releases its reservations together.
6. Commit all changes or roll back all changes.

For current SQLite, `BEGIN IMMEDIATE` before reading the contested stock/coverage is a candidate strategy, consistent with the upstream record-write pattern. The final design must account for all stock writers, lock contention, uniqueness races, and retry behavior. Another persistent backend would need its own proven locking or conditional-update strategy. In-memory lock/fake-adapter tests do not establish database concurrency guarantees.

Completion timestamps alone are insufficient. Durable operation records, event identity, immutable approved terms, stock/coverage constraints, and transaction boundaries are necessary. Redis remains an estimate cache, never authoritative order, purchase, reservation, or inventory storage.

## Approval and impact conventions

Reuse the platform's proposal → validation → impact → explicit approval interaction where appropriate. Before approval, present selected suppliers and their purchased quantities, total agreed cost in the configured currency, current shortage, expiry/deadline checks, and remaining budget. Revalidate all of those under the approval transaction; a displayed recommendation may have become stale.

The approver comes from the authenticated account and approved company permission. Standalone owner identities are fixture/context inputs pending this adapter. Quote edits and browser/server/Redis expiry cannot change approved PO terms: use immutable quotes or a PO snapshot containing selected quote identity, purchased quantity, price/currency, delivery commitment/estimate source, approver, and approval time.

Existing CRM spec reversion (`agentic/chat.py:361–381`) changes configuration. Stock movements are business events and must never be treated as reversible configuration edits. A future compensating movement would require a separate approved workflow; returns/cancellations are outside v1.

## Proposed migrations, only after approval

Maintain two separately reviewed change sets:

| Change set | Proposed scope |
| --- | --- |
| Logistics extension | Approved order/line, quote, PO, stock/reservation, and durable-operation structures from the revised schema proposal; business-qualified keys/references; immutable approved terms; split purchases; nonnegative stock/quantity checks and guarded lifecycle constraints. Do not create a second catalog/stock authority. |
| Wider core prerequisites | Confirm business/company relation and party/item ownership; add required company-qualified candidate keys; separately address existing EAV/generic links and ownership/reference constraints. This is not bundled into a logistics rules change. |

Migration review must identify which names map to existing authoritative tables and which truly require additions. Provide non-destructive migration/backfill/validation steps and disposable migration tests before applying anything. The seven original tables are a starting point; durable operations and any explicit stock/reservation structure must be justified by atomicity and ownership requirements. Do not provision separate databases per company.

## Minimal backend/UI work after approval

1. Agree mapping/isolation/interface/split scope and update OperationsNerd in a safe branch from an agreed baseline.
2. Implement the smallest core adapter and persistent repository using approved IDs and the existing authentication/transaction conventions. Keep domain code independent.
3. Add company-scoped command/read endpoints under the verified `/api` surface, with explicit approve, full receive, and full fulfill actions and operation keys. Route names are intentionally not claimed as existing APIs.
4. Add the smallest `/app` controls for multi-line demand, reserved/shortage/inbound quantities, supplier recommendation and source labels, explicit approval, per-PO receipt, and full-order readiness/fulfillment.
5. Connect existing comparison/cache through a typed estimate adapter; preserve the existing demo and cache behavior. Validate synthetic estimates and expired data before purchase approval.
6. Demonstrate the persistent flow using disposable storage, restart, real API authorization, and concurrent requests before describing it as integrated.

No OperationsNerd backend route, app control, migration, persistent repository, core adapter, or external supplier action is implemented by these documents. The subsequently authorized [local browser demo](frontend-demo.md) is a disposable fixture bridge to the standalone rules; it does not implement this integration plan.

## Required later integration tests

- Session ownership: anonymous access, another account, same account's other business, forged company/approver input, and replay-result disclosure.
- Database isolation: direct SQL attempts to cross company boundaries for parties/items/orders/lines/quotes/POs; wrong quote-line pair; duplicate SKU permitted across companies but rejected within one company.
- Transactions: injected failure between stock update, reservation change, completion state, and durable result leaves all untouched; retry after timeout returns original result.
- Real concurrency: two orders compete for stock, two approvals compete for remaining shortage, two keys receive the same PO, two keys fulfill the same order. Run against the actual persistent adapter and prove balances/coverage once.
- Durability: close/reopen process and storage, then replay reservation/approval/receipt/fulfillment; preserve frozen purchase terms even after estimate-cache expiry or quote edits.
- Workflow: multi-line/duplicate constraint handling, one-location stock, split supplier capacity, cumulative budget, expired/currency/deadline failures, unchanged stock on approval, first receipt insufficient for readiness, whole-order fulfillment preserving another order's reservations.
- Boundaries: explicit rejection of partials/returns/cancellation/transfers; no automatic PO from recommendations; synthetic estimate labels; existing supplier comparison/cache regressions.

Run current standalone tests separately. The list above is future acceptance work, not a claim that these integration tests were executed.

## Short review questions for Amaan and Shasha

1. **Mapping:** Which stable IDs and entity types are authoritative for customers, suppliers, items, customer orders, and stock? Should legacy `contacts` or generic `entities` be adapted, and who owns the catalog/stock API?
2. **Isolation:** Is `businesses.id` the company boundary in the shared database, how does one account's multiple businesses map to companies, and who owns the separate core company/reference migration?
3. **Interface:** Can the host supply a trusted context, shared transaction, typed identity/stock repository, and explicit approval handler to `modules/logistics/`? Who owns that core adapter and contract version?
4. **Split sourcing:** Approve multiple explicitly allocated POs per order line for v1 integration, or record an explicit temporary single-supplier deferral? Confirm fixed-quantity quote pricing and cumulative shortage-purchase budget semantics.
5. **Accounting:** Who owns accounting, and what stable purchase/receipt/fulfillment references or event contract should logistics expose? What must be persisted transactionally for delivery/retries? An event stub alone is not accounting integration.

The smallest next step is review and explicit approval of those mappings and boundaries. Until then, retain the standalone rules/tests/demo and revise proposals only.
