# Wider core migration dependencies — separate review

This document proposes no executable migration. No core database or OperationsNerd file was modified. It separates cross-cutting platform decisions from the [logistics schema proposal](schema-proposal.md), consistent with fetched OperationsNerd architecture at `dbff470`.

| Dependency | Verified present | Decision or wider change needed before logistics persistence |
| --- | --- | --- |
| Company identity | `businesses.id`; upstream account owner stored as text `owner_key` | Confirm whether a business is a company, multiple businesses/account rules and future company/tenant ID. Agree relational ownership constraints and permissions separately. |
| Parties | Legacy `contacts` plus separate generic `entities` with type/JSON attributes | Select canonical customer/supplier namespace and role/status contract. Add required company-qualified relational candidate keys or a typed bridge with company/type enforcement. Do not reinterpret arbitrary CRM labels as parties. |
| Items | No verified canonical item table/API | Confirm shared catalog owner and exact identifiers, unit and SKU normalization; company-specific SKU uniqueness. If another team builds items, reuse it. No duplicate module catalog as a shortcut. |
| Stock | No verified authoritative stock API/table | Confirm one authority, unit/location, all writers and shared transaction participation. Reuse approved stock rather than independent module balances if it exists by integration time. |
| References | Core has application checks for some cross-business legacy/EAV links | Add `(business_id,id)` candidate keys and composite references where selected target tables need them. Wider EAV/link integrity and company-ID work belongs to core review/backfill, not an implicit logistics migration. |
| Approvers | Upstream session/account auth; owned-business checks | Agree account/business permission and a database-valid approver relationship for purchase audit; derive actor from core context, not client input. |
| Accounting | Architecture says shared accounting is planned | Identify owner, stable contract, event identity, transactional/outbox delivery and retry responsibilities if required later. No ledger or posting API is assumed or built. |

After approval, each core change needs its own schema diff, inventory of affected tables/writers, legacy data assessment, non-destructive backfill, constraint-validation queries, disposable migration tests and deployment/rollback plan. A proposed bridge must preserve existing IDs and reject unresolved or wrong-company/type mappings; it must not clone customer/supplier/item records. SQL syntax and migration engine remain open until the target contract is accepted.

The local checkout still lacks the fetched `/app`/`/api` code. Updating that baseline safely is a separate repository step: preserve the uncommitted logistics proposal, agree the upstream base and use an isolated branch/checkout. No dirty-tree pull or automatic merge was performed here.
