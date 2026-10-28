# Purchasing and stock function map

This inventory describes the implementation in **LogisticsNerd**, not changes to
the OperationsNerd repository. One private PostgreSQL database represents one
business. Core records enter through an explicit adapter projection; local
bindings do not define a second authoritative item or supplier catalog.

All mutation functions take a database connection and an `idempotency_key`.
The backend resolves the business database and authenticated actor before calling
them. One durable request registry is shared by purchasing and stock. A matching
retry returns its original result. A changed operation or payload with the same
key fails. No purchasing or stock helper commits independently.

## Purchasing implementation

These functions live in `logistics_persistence/purchasing.py`. They are local
PostgreSQL implementations; deployment and authoritative core mapping remain
separate integration work. See the test results before treating any behavior as
verified against a configured database.

| Function | Reads | Writes | Owner |
| --- | --- | --- | --- |
| `create_quote` | Current supplier/item bindings; previous quote versions | New immutable `quote_versions` row; shared request result | Purchasing |
| `get_quote`, `list_quotes` | `quote_versions` | None | Purchasing |
| `compare_suppliers` | Demand; quotes; reservations; approved allocations; receipt allocation links | None; does not approve or order | Purchasing |
| `create_purchase_order` | Supplier binding | Draft `purchase_orders`; request result | Purchasing |
| `edit_purchase_order` | Draft version; quote/supplier relationships | Draft supplier revision/currency and version; request result | Purchasing |
| `add_purchase_line` | Draft; quote version; supplier mapping | `purchase_order_lines`; draft version; request result | Purchasing |
| `edit_purchase_line` | Draft; quote; allocations | Draft quantity and version; request result | Purchasing |
| `remove_purchase_line` | Draft and its allocations | Removes an empty draft line; draft version; request result | Purchasing |
| `allocate_purchase_line` | Draft line; customer demand; existing allocations | `purchase_allocations`; draft version; request result | Purchasing |
| `edit_purchase_allocation` | Draft line and other allocations | Draft allocation quantity/cost share; draft version; request result | Purchasing |
| `remove_purchase_allocation` | Draft/line/allocation | Removes draft allocation; draft version; request result | Purchasing |
| `approve_purchase_order` | Actor permission; current supplier/item bindings; quote versions; demand; existing reservations, shipments, approved commitments | Frozen line terms/allocations; approval actor/time; supplier snapshot; header total/status/version; request result | Purchasing |
| `get_purchase_order`, `list_purchase_orders` | PO header/lines/allocations | None | Purchasing |
| `purchase_progress` | PO lines; `receipt_lines`; explicit `receipt_allocations` | None | Purchasing |
| `_validate_receipt` (private transaction helper) | Approved PO lines; allocations; existing receipts | Row locks only; no stock balance/counter | Purchasing contract, invoked by stock |

### Quote and approval rules

- A quote reference has immutable numbered versions. Revising terms appends a
  version and retains the previous version. One exact version may be referenced
  by one purchase line at a time.
- Each PO belongs to one supplier and currency. Each line uses a quote for the
  same logical supplier and item. Fixed-total quotes price exactly their stated
  quantity; unit quotes cannot exceed their priced quantity or capacity.
- Only supplier quotes can be approved. Synthetic and AI suggestions remain
  estimates. Expiry, delivery dates, currency, quantities, demand and budgets are
  checked again during approval under database locks.
- Approval requires an adapter-supplied actor binding with
  `snapshot.can_approve_purchases: true`. The HTTP/backend authentication boundary
  must supply that actor; a user-submitted actor ID is not authorization.
- The expected document `version` detects stale edits. Approved headers, line
  terms and allocations are immutable. Approval creates **no stock**.
- Every purchased quantity is allocated to demand in this first milestone.
  One demand can use multiple supplier POs; one PO line can supply multiple
  customer lines. The first interface may still select one supplier per shortage.
- For a single allocation the full line cost is its cost share. For several
  allocations with customer budgets, callers must explicitly provide all cost
  shares, and the shares must sum to the exact line cost. No automatic
  proportional/remainder policy has been assumed. Agreed budget costs are frozen
  with the allocation snapshot. Company agreement is still needed before adding
  an automatic allocation policy.
- Supplier revisions retain validity intervals. An approved PO stores the exact
  supplier revision and supplier snapshot. A later address change does not alter
  the approved document. A draft can select a newer revision of the same supplier.

`compare_suppliers` reuses the deterministic standalone solver. Its limits remain
2,000 units, 32 quotes and 500,000 examined transitions. It requires one current
offer per supplier; it does not stack alternative offers from one supplier.

### Dates and quantities

`created_at` is the PO creation timestamp. `approved_at` is approval time.
`expected_date` is the supplier delivery date. Demand `required_by` is the
customer deadline. Stock `received_on` is the actual delivery date. Shipment
dispatch/tracking times belong to stock. These fields do not silently treat
every line-item date as the same event.

Quantities are whole units. Money is integer minor units, named `*_minor` in the
database. Currency conversion and fractional units are not part of this slice.
Outstanding quantities are computed from accepted receipts. There is no editable
purchasing stock balance.

## Receiving connection

Purchasing calls `stock.receive_delivery`. Each physical line identifies a PO
line, item, location, quantity and optional lot/expiry. It carries zero or more
explicit `{purchase_allocation_id, demand_line_id, quantity}` portions.

Stock calls `_validate_receipt` inside its transaction, before posting stock.
That helper aggregates repeated PO/allocation portions, locks their rows in the
common order, checks approved status and matching item/customer references, then
checks both outstanding limits. Stock records the header, receipt portions,
movements, reservations and allocation links in that same transaction.

The caller creates one request key per logical delivery and reuses it on every
retry. Physical `delivery_ref` is unique independently of the request key so a
new key cannot silently post the same named delivery again. Partial deliveries
use distinct delivery identities and may reference the same PO line.

The stock module owns receiving execution, stock ledger, lots, reservations and
shipping. Purchasing owns the purchase limits and reads progress from receipt
records. Neither module duplicates the other's balances or receipt totals.

## Wider professor function inventory

These functions remain visible so an MVP does not hide broader requirements.
They are **not all purchasing implementations** in this milestone.

| Function | Tables or contracts read | Tables or contracts written | Ownership/status |
| --- | --- | --- | --- |
| Configure business and standard record tables | Business setup and registered definitions | `business_setup`, `record_tables`, `record_fields`, typed `record_*` tables | Standalone questionnaire implemented; OperationsNerd adapter pending |
| Create/read/update/archive/delete supplier, customer, item, shipper, location or employee | Registered typed record tables; reference targets; purchasing/stock dependencies | Typed `record_*` rows, local reference bridge, `record_events`, shared request registry | Standalone generic CRUD implemented; employees do not grant access |
| Create a user table or add a field | Registered definitions and target tables | Additive typed SQL table/column, real foreign keys, metadata and request result | Same CRUD forms handle new definitions; removal/type changes require future migrations |
| Change fields through OperationsNerd chat | Core specifications and configured field values | Core specification/version/value model | Core production mapping pending; standalone notes do not execute chat configuration |
| Read supplier at a historical time | Core revision validity intervals; PO frozen snapshots | None | Core adapter + purchasing snapshot |
| Create/read/edit/delete/archive draft customer orders and lines | Local customer/item records and registered fields | `record_customer_orders`, `record_customer_order_lines`, audit/request records | Standalone UI and constraints implemented; authoritative host mapping pending |
| Submit a customer order to purchasing | Active local customer/items and all active draft lines | Atomic `demand_lines` publication, frozen order/line links, audit/request result | Implemented; amendment/cancellation after submission still requires policy |
| Read stock by location | Immutable ledger, reservations, lots | None | Stock projection |
| Receive goods; reserve/release stock | PO/allocation limits; stock resources and demand | Stock receipts, movements, reservations, explicit links | Stock implementation; purchasing initiates receipt |
| Create/read/edit shipment and lines; dispatch | Demand/order references; active reservations; carrier contract | Stock shipments, lines, dispatch, shipment movements | Stock |
| Record carrier update/read shipment state | Shipment and event history | New tracking event only; state derived | Stock; five states, delivered terminal |
| Maintain carrier transport options and generate labels | Core shipper/options contract; carrier integration | Core options or label evidence | Core/stock integration; provider contract pending |
| Damage/count corrections/customer returns | Original movements, locations, lots and shipment references | New compensating movements; never erase posted stock | Stock extension; not implemented by purchasing |
| Move stock between locations | Source/destination resources, reservations/lots | Atomic outward/inward transfer movements | Stock extension; not silently part of receipt MVP |
| Approved PO amendment/cancellation | Approved terms, receipts, demand commitments | Future version/amendment/audit model | Purchasing policy pending; approved rows cannot be deleted |

Authoritative core item keys, standard-entity representation, automatic
multi-demand cost sharing, approved amendments and carrier/label integration
remain explicit team dependencies. This local implementation does not settle
those production contracts by inventing new core entities.
