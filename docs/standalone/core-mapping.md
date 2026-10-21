# Core mapping and verified boundaries

Review date: 21 October 2026. This is a proposal for reusable LogisticsNerd rules inside OperationsNerd. It does not authorize a shared-schema migration or backend/UI integration. The standalone repository is in memory; supplier fixtures are synthetic.

## Evidence and revision boundaries

OperationsNerd was inspected at `/Users/somaditya/Logistics Nerd/OperationsNerd`. Its checkout remained on `main` at `622d8d7b47378c3e427212859d90a52eccfeb040`, with the pre-existing untracked `documentation/logisticsnerd/` preserved. A fetch made `origin/main` available at `dbff470`; upstream files were read using `git show origin/main:<path>`, without pulling or merging into the dirty checkout.

The paths and line numbers below identify source at the stated revision. A fetched-upstream path may not exist in the working checkout. This distinction matters: local `622d8d7` exposes the legacy `/ui` application; authenticated `/app` and `/api` are verified in fetched `dbff470`, not installed in that checkout by this work.

| Evidence | Verified fact |
| --- | --- |
| Local `622d8d7`, `operations_nerd/db/schema.sql:16–36` | `businesses.id` and `contacts.id` are integer primary keys; contacts have `business_id`. |
| Local `622d8d7`, `operations_nerd/db/schema.sql:39–105` | Other defined core tables are `follow_ups`, `entity_attributes`, `events`, `drafted_actions`, and `approval_policies`. |
| Local `622d8d7`, `operations_nerd/main.py:23–30` | Legacy routers and `/ui` are mounted; this revision has no authenticated `/app` or `/api` module integration. |
| Fetched `dbff470`, `operations_nerd/db/schema.sql:118–126` | `entities` anchors generic CRM records with integer `id`, `business_id`, and `entity_type`; it does not define an inventory item or party contract. |
| Fetched `dbff470`, `operations_nerd/db/schema.sql:136–188` | Accounts, sessions, spec versions, proposals, and daily chat usage exist. |
| Fetched `dbff470`, `operations_nerd/db/db.py:32–36` | Initialization adds nullable `businesses.owner_key` and `current_version`; the schema file alone is not the complete initialized definition. |
| Fetched `dbff470`, `operations_nerd/agentic/store.py:33–44,69–84` | Agentic businesses store the owning account ID as text in `owner_key`; business reads verify both business ID and owner. |
| Fetched `dbff470`, `operations_nerd/agentic/auth.py:191–199` | `current_account(request)` resolves the session cookie to a logged-in account or raises 401. |
| Fetched `dbff470`, `operations_nerd/main.py:43–44,55–69`; `agentic/routes.py:17` | `/app` and `/api` are the production surfaces; unauthenticated legacy routes are removed in production. |
| Fetched `dbff470`, `documentation/CONTRIBUTING.md:73–74` | Logistics starts in `modules/logistics/` with its own tests and no core imports. The module interface is not built. |
| Fetched `dbff470`, `documentation/agentic_crm_architecture.md:196–211` | Shared parties, items, and accounting are planned, not built. The direction is one shared database. Wider company IDs and database-level generic links are a separate planned migration. |

These statements verify source definitions and source behavior, not the contents of a deployed database. No production database or deployed endpoint was inspected, migrated, or exercised.

## Seven starting tables: actual versus proposed

| Starting name | Status in inspected core | Proposed mapping and unresolved owner |
| --- | --- | --- |
| `businesses` | Existing in local and fetched source | Reuse `businesses.id` after authenticated owner lookup. Whether future company identity is exactly this business ID needs confirmation. An account can own multiple businesses; account ID is not company ID. |
| `contacts` | Existing legacy core directory | Candidate source for existing customers/suppliers only after mapping is approved. Generic production CRM records in `entities` are a different namespace. Confirm roles, identifiers, and whether shared parties will replace or adapt these records. |
| `items` | Proposed in local logistics documentation; no authoritative item table in inspected core | Reuse the eventual catalog identifier through an adapter. Do not create a duplicate catalog or infer an item from an arbitrary CRM entity label. Item owner, unit, SKU normalization, and stock mapping are dependencies. |
| `orders` | Proposed; no persistent logistics customer-order contract in inspected core | Logistics demand model proposed. Confirm whether another module owns customer order IDs before creating a persistent table. |
| `order_lines` | Proposed | Proposed typed demand/reservation model; reference approved order and item identities. Confirm ownership before persistence. |
| `supplier_quotes` | Proposed persistent table; existing comparison/cache is a separate estimate demo | Save immutable estimate/quote terms through a future adapter; existing cached suggestions are not supplier commitments or inventory authority. |
| `purchase_orders` | Proposed | Logistics owns explicit approval, purchased quantity, frozen terms, and whole receipt rules subject to module contract approval. Multiple POs may reference one demand line for split sourcing. |

There are no verified authoritative shared stock tables or production warehouse operations in the inspected revisions. The expanded local logistics design explicitly calls its warehouse/inventory schema provisional. Do not treat that proposal as an implementation supplied by Amaan.

## ID adapter proposal

The standalone rules use opaque IDs and a company scope. Those are deterministic fixture identities in the in-memory demo, not authentication or a shared core migration.

For future integration, resolve a trusted context from the existing session account and an owned business. The business selector can be supplied in a route, but its value becomes trusted only after the core ownership check. Construct company identity from that resolved context, never from a submitted `business_id`, `company_id`, `approver_id`, or owner name in the command body.

Proposed adapter references must preserve their source namespace:

| Domain concept | Candidate external reference | Required validation before use |
| --- | --- | --- |
| Company | Authenticated, owned `businesses.id` | Confirm business-to-company mapping and ownership policy; deny another account's business and same-account wrong-business links. |
| Customer/supplier | Either legacy `contacts.id`, or generic `(business_id, entity_type, entities.id)`, or future shared party ID | Confirm one mapping, intended role and active status. Resolve within the trusted business and expected type; never equate legacy contact and generic entity IDs. |
| Item | Eventual shared catalog ID | Confirm item existence, owning business, integer unit policy, company-specific SKU identity, and authoritative stock source. No duplicate core row is created when unresolved. |
| Approver | Authenticated `accounts.id` with resolved company ownership | Derive from the session, recheck permission at approval time, persist actor and time with approved terms. |
| Stock | Approved catalog/stock adapter reference for one company location | Read/write the one authoritative on-hand balance and all active reservations. No Redis-derived balance. |
| Accounting | Unresolved | Identify owner, stable event/reference contract, and failure/retry responsibility before claiming integration. |

The production CRM supports arbitrary `crm_*` entity keys and field/link keys. That does not establish a fixed customer, supplier, or item schema. Labels are not stable identifiers. A proposed mapping must identify actual keys and IDs, or remain an explicit dependency.

## Original diagram review and preservation

The original is preserved at `/Users/somaditya/Logistics Nerd/OperationsNerd/documentation/logisticsnerd/logisticsnerd-starter-clean.drawio`; it remains part of the pre-existing uncommitted documentation. No OperationsNerd file was changed. The attached screenshot is supporting context; the XML and source definitions were inspected directly.

The XML is uncompressed and has diagram ID `logisticsnerd-seven-table-clean`, named `7-table schema - 3NF`. Its `object` metadata includes `schemaColumns`, `schemaIndexes`, `schemaSQL`, and explicit foreign-key source/target columns. It contains seven table objects and eight foreign-key objects. Table objects begin at XML lines 92 (`businesses`), 97 (`contacts`), 102 (`items`), 107 (`orders`), 112 (`order_lines`), 117 (`supplier_quotes`), and 122 (`purchase_orders`).

The revised shared-database proposal must address these exact limitations:

1. The diagram and `starter-schema.sql:4–9` assume one company database and add a unique constant index on `businesses`. New logistics tables omit `business_id`. This conflicts with the current shared-database request and fetched umbrella direction.
2. `items.sku` is globally unique in the proposed table (`starter-schema.sql:10–16`). Shared storage needs company-specific uniqueness, with the final catalog mapping approved first.
3. Order/contact, line/item, and quote/supplier references are single-column foreign keys. They cannot enforce company-consistent references in shared storage. Add company-qualified candidate keys and composite foreign keys in the proposal; separate wider core prerequisites from module additions.
4. The quotes table (`44–53`) stores capacity as `available_quantity` but omits explicitly priced quantity, currency, and expiry. It assumes every quote prices the whole original frozen shortage. Split sourcing requires those quantities to be distinct and terms to be explicit.
5. `purchase_orders.customer_order_line_id` and `selected_quote_id` are each unique (`61–66`). The unique order-line restriction prevents multiple suppliers serving one demand line. Remove that restriction in the proposal; repeated quote use still needs an explicit quantity/capacity policy.
6. The PO has no purchased quantity, agreed price/currency snapshot, or identified approver; `confirmed_at` supplies a confirmation time. It derives terms from the demand line and selected quote. The old notes require those source terms to be frozen, but the DDL does not enforce that. Approved terms must remain immutable or snapshotted independently of cache expiry and recommendation changes.
7. Independent PO foreign keys do not ensure the selected quote belongs to the referenced order line. XML FK objects at lines 72 and 82 model those independent links. A company/line/quote composite relationship is needed.
8. The line's `quantity_to_purchase` represents the original shortage in the old proposal (`starter-schema.sql:74–87`). A new name/definition must distinguish historical original shortage from the current remaining unallocated shortage. Inbound assignments must be counted once and replaced by physical reservation on receipt.
9. `received_at` and `fulfilled_at` provide completion evidence but cannot store request-key payload fingerprints/results or stop conflicting durable concurrent postings alone. Durable operation keys and guarded business-event identity are required.

The historical `README.md`, `DRAWIO_GUIDE.md`, `NORMALIZATION.md`, and expanded `WORKFLOW_AND_ROADMAP.md` in that same uncommitted folder contain earlier separate-database and/or single-supplier decisions. They are evidence of earlier design, not instructions or approval for this task. The new proposal and change log are separate artifacts in this repository; the original is retained.

## Wider core migrations remain separate

Company-qualified contact/entity/account ownership constraints, company IDs on existing EAV/link structures, and replacement of `owner_key` with any future relational ownership model belong to a separately reviewed core migration. New module tables should carry `business_id` and use composite references, but that does not repair every existing core table automatically. Existing unscoped legacy accessors must not be called directly from a future logistics route without an ownership adapter.

No wider migration, catalog creation, stock integration, accounting implementation, backend route, or UI connection is part of the standalone delivery.
