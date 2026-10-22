# Standalone LogisticsNerd rules

The Python rules implement the requested workflow **in memory**, using synthetic suppliers. They import no OperationsNerd, HTTP, LLM, Redis or external library. A separately authorized [local browser demo](frontend-demo.md) now uses those rules through a Vite/Python bridge. No persistent adapter, migration, OperationsNerd backend/UI connection, authentication integration, supplier commitment or accounting integration has been implemented. The existing TypeScript comparison keeps its default total-price behavior and cache identity; the workflow adds separately cached Baseten unit estimates. Its original page is available at `/supplier-comparison.html`.

From the LogisticsNerd repository root, using Python 3.11+ (executed here on 3.14.7):

```sh
python3 -m unittest discover -s tests_python -v
python3 -m logistics_rules.demo
```

The demo is self-contained and asserts every critical result. Restarting it creates a new in-memory repository; it does not read any real company inventory. Dates are deterministic fixture dates, not live promises. Capacity/priced quantity/price/source are synthetic. V1 comparison and approval freshness use the UTC calendar date; a company-local calendar policy requires agreement before integration.

## Files and contract

| File | Purpose |
| --- | --- |
| `logistics_rules/workflow.py` | Immutable records, order normalization, reservations, shortage views, explicit approval, whole receipt/fulfillment and lifecycle rejection. |
| `logistics_rules/selection.py` | Immutable quote terms and deterministic comparison port, extended to exact split sourcing. |
| `logistics_rules/repository.py` | Small `Repository` port: company-scoped `read` and atomic replay-aware `transact`; fixture-only `InMemoryRepository`. |
| `logistics_rules/demo.py` | Requested 15-unit customer order with 4 available stock, 7+4 purchases and final stock 2 reserved for another order. |
| `tests_python/test_workflow.py` | Workflow, company isolation, replay, competing operations and rollback checks against the fake adapter. |
| `tests_python/test_selection.py` | Quantity/pricing, budget/deadline/expiry/currency rules, actual existing sample JSON compatibility and independent exhaustive split-solver checks. |

`Workflow(repository, clock=...)` accepts a repository and a timezone-aware clock. All operations take `business_id` first. That is fixture context here, not authentication. A future core host must resolve business and approver from the authenticated account before invoking the module. `seed_company` exists only on the fake adapter and must never become a client-facing API.

| Command/read | Proposed standalone call shape |
| --- | --- |
| Create demand | `create_order(business_id, order_id, customer_id, tuple[LineRequest], key=...)` |
| Allocate existing stock | `reserve(business_id, order_id, key=...)` |
| Inspect state | `shortage(business_id, line_id)`, `stock(business_id,item_id)`, `get_order`, `get_line`, `get_po` |
| Save immutable terms | `add_quote(business_id, Quote(...), key=...)` |
| Recommend, no purchase | `recommend(business_id, line_id)` |
| Explicit owner purchase | `approve(business_id, line_id, selections=((quote_id,quantity),...), owner_id=..., approval_id=..., key=...)` |
| Receive full PO once | `receive(business_id, po_id, key=...)` |
| Fulfill entire order once | `fulfill(business_id, order_id, key=...)` |
| Reject excluded actions | `transition(..., action='cancel'/'return'/'transfer'/...)`; partial quantities are also rejected by receipt/fulfillment methods. |

IDs are company-scoped, opaque fixture strings; production maps existing core IDs through an approved typed adapter. `LineRequest` specifies item, positive integer quantity, calendar deadline, optional aggregate purchase budget in cents, and normal/urgent priority metadata. Priority does not reorder reservations or invoke optimization. Duplicate items merge in first-seen order only with identical constraints; an identical budget is retained once. Orders/demand and commercial terms are immutable in v1.

`quantity_to_purchase` means current remaining **unallocated** shortage. It is derived each time from original demand minus active reservations minus assigned unreceived approved purchases, never a stale frozen number. First reservation separately captures historical `original_shortage`. Received purchases move from inbound coverage to physical reservation once; completed demand has no shortage even though reservations are released.

The budget applies to all purchased shortages for the normalized line, including earlier approvals/receipts, excluding already-owned stock. Costs are integer cents in one explicitly configured company currency. Prices are all-in fixture terms; no taxes, exchange, ledger or accounting cost allocation is calculated.

## Comparison reuse and split bounds

The Python selector ports the existing `src/domain/compare.ts` quantity/deadline/budget and lowest-cost → earlier-date → supplier-ID ordering. A compatibility test reads the real `src/data/demo.json`; original price/availability/delivery values are preserved. The existing browser still supports its two preferences and display of all tied winners. Python v1 chooses one deterministic lowest-cost allocation; earliest-delivery preference is not exposed as a separate Python optimization mode. Priority metadata is not that preference.

Split plans minimize combined cost; ties favor fewer units arriving on the latest date, then earlier dates, then lexical supplier IDs. Fixed-total prices cover exactly their priced lot; they are never prorated. Unit terms cover up to the smaller of capacity and quantity priced. One immutable quote per supplier/line, purchased at most once, avoids stacking revisions of the same supplier capacity. Requoting and supplier-wide capacity shared across different demands remain outside this prototype; quotes describe capacity offered to their particular demand.

The exact prototype search rejects inputs beyond 2,000 needed units, 32 quotes or 500,000 examined transitions. These are explicit solver limits, not a claim of arbitrary-scale optimization. No heuristic silently replaces an exact result.

## Operation keys and transitions

Keys are scoped to a company across all command kinds. The fake stores versioned, type-sensitive request identities and detached original successful results. Same key + same ordered payload returns that result, even after later lifecycle actions. Another payload or command with that key fails; `1`, `True` and `1.0` are distinct payloads. Lines/selections preserve caller order, so reordering is a payload change. The implicit clock is not part of the payload: successful replays return the original timestamp/result instead of creating another event.

An exception rolls back the whole candidate state, including operation-result storage. Failed operations have no successful stored key and can be retried after correcting the request or conditions. New keys may safely recalculate reservations, but cannot recreate an order/approval identity, repurchase a used quote, re-receive a PO or re-fulfill an order. Those are separate business-event guards. Original successful replay results can describe an earlier state; use read methods for current state.

Create → open; reserve/receive can make an order ready; whole-order fulfillment makes it fulfilled. Explicit approval creates an approved PO without changing stock. Full receipt makes that PO received and reserves its goods for the linked line. Approval/receipt/fulfillment are atomic within the fake's process-local lock and copy-on-write transaction. The tests do **not** establish durable database transactions, distributed locks or database concurrency safety. Receipt and fulfillment timestamps alone are insufficient for a real adapter.

## Review artifacts

- [Actual demo stdout](results/demo-output.txt), [Python test output](results/python-tests.txt), [existing demo tests/build output](results/demo-regression.txt), and [verification/baseline record](verification.md).
- [Core table/ID mapping](core-mapping.md): facts at local and fetched upstream revisions, assumptions and dependencies.
- [Revised schema and change log](schema-proposal.md), [revised Draw.io](shared-proposal.drawio), [unaltered original Draw.io copy](reference-original.drawio).
- [Separate wider core prerequisites](core-migration-dependencies.md), [module contract and integration plan](integration-plan.md), including short questions for Amaan/Shasha.

Stop before persistent work. The smallest next step is explicit agreement on item/stock mapping, company isolation, module interface and split-sourcing scope; identify accounting ownership before claiming accounting integration.
