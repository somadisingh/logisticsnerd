# PostgreSQL purchasing / stock contract

Implemented schema: `logistics`. One private PostgreSQL database represents one business. Numeric domain identifiers use PostgreSQL bigint identities. Quantities are positive integral units; prices are integer minor units. External item/supplier/location identities enter through `core_bindings`. The standalone business-record adapter also supplies local bindings; authoritative OperationsNerd mapping remains pending. Existing synthetic bindings remain fixtures.

## Shared command boundary

`db.run_command(conn, operation, idempotency_key, payload, work)` calls `work(conn)` in one transaction. All helpers in purchasing and stock use that connection and never commit. A single `command_requests` primary key makes keys unique across both modules. Identical operation and JSON payload returns the saved JSON result; changed content or operation raises `IdempotencyConflict`. A failed transaction persists no request or domain rows. The connection uses psycopg's dictionary row factory.

Lock order: command key (runner), all PO lines in ascending ID, all purchase allocations in ascending ID, stock item IDs then `(item_id, location_id)` resources in ascending order, reservations, shipments/lots. Shipment line additions and dispatch first take a shipment-specific advisory lock before resource locks so the line set cannot change during dispatch. Read contested ledger totals only after acquiring their stable resource lock. `stock_resources` holds lock identities only, never a quantity balance. Database triggers also acquire resource locks for direct SQL writes and enforce ledger consistency.

## Core adapter references

- `core_bindings(id,kind,external_key,snapshot,valid_from,valid_to)`: kind is item, supplier, customer, location, carrier or actor. Revisions retain snapshots. `(kind,external_key,valid_from)` is unique. Production binding creation requires an authoritative adapter.
- `demand_lines(id,external_key,order_ref,item_id,quantity,currency,budget_minor,required_by)`: adapter-provided customer demand; `external_key` unique. `order_ref` identifies the customer order header.

## Standalone business records

`business_setup`, `record_tables`, `record_fields`, `record_binding_links` and
append-only `record_events` support the questionnaire and registered-table CRUD.
Setup creates typed `record_suppliers`, `record_customers`, `record_items`,
`record_locations`, `record_carriers`, `record_employees`,
`record_customer_orders` and `record_customer_order_lines`. User tables follow
the same `record_<slug>` convention and API, with real reference foreign keys.
No generic endpoint accepts ledger or purchasing tables.

Submitting a customer order publishes every active line to `demand_lines` in
one transaction and freezes the order/lines. Standard records map to local
bindings; supplier edits retain historic revisions. Employees do not map to
authorization actors. New composite foreign keys enforce supplier/item/actor
kinds on purchasing and demand references. See
[the business workspace contract](business-workspace.md) for supported CRUD,
schema changes and the external OperationsNerd boundary.

## Stock tables

- `stock_lot_tracking(item_id)`; `stock_lots(id,item_id,lot_number,expiry_date)`; `stock_lot_holds(id,lot_id,event,reason,request_key)`.
- `stock_resources(item_id,location_id)` is a mutex identity, not inventory.
- `receipts(id,delivery_ref,request_key,received_on)`: physical delivery identity is unique separately from the request key.
- `receipt_lines(id,receipt_id,line_number,po_line_id,item_id,location_id,quantity,source_ref,lot_id)`: quantities are physical portions, not copies per reservation; PO line nullable only for legacy/simple stock-only APIs.
- `receipt_allocations(id,receipt_line_id,purchase_allocation_id,demand_line_id,reservation_id,quantity)`: explicit purchasing allocation-to-receipt link; several allocations may consume one receipt line. These rows are immutable.
- `stock_reservations(id,item_id,location_id,order_ref,demand_line_id,quantity,quantity_shipped,status,request_key)`: status active, released or fulfilled; shipped quantity is maintained only by movement trigger.
- `lot_allocations(id,reservation_id,item_id,lot_id,quantity,as_of)`: distinct from purchasing allocations; immutable FIFO/FEFO assignment.
- `stock_movements(id,item_id,location_id,quantity,movement_type,reservation_id,lot_id,as_of,receipt_line_id,shipment_id,shipment_line_id,source_ref,request_key)`: immutable ledger; quantities derive only from this ledger. Movement types opening, receipt, shipment. Several child movements may share a request key.
- `shipments(id,shipment_number,order_ref,request_key)`, `shipment_lines(id,shipment_id,reservation_id,quantity)`, `shipment_dispatches(shipment_id,carrier,label_ref,tracking_ref,as_of,request_key)`, `shipment_events(id,shipment_id,event,occurred_at,detail,request_key)`.
- `stock_levels`, `stock_lot_levels`, `shipment_status`, `demand_fulfillment` views expose derived quantities/states. Shipment states draft, dispatched, in_transit, delivered, exception. Any delivered event makes delivered terminal.

## Whole-delivery API

`stock.receive_delivery(conn, delivery_ref, lines, idempotency_key, received_on, as_of=None)`.

Each line is `{po_line_id, item_id, location_id, quantity, lot_number?, expiry_date?, allocations:[{purchase_allocation_id,demand_line_id,quantity}]}`. `source_ref` is derived as `str(po_line_id)`. Allocation portions sum to at most the received physical line quantity; the rest is free stock. Several portions for one PO line are valid, including separate lots. The command locks and validates PO and allocation totals before stock writes; approved PO required, item/demand links must match, PO and allocation quantities cannot be exceeded. Every receipt/movement/reservation/allocation row is committed together. Returns `{receipt_id,delivery_ref,lines:[{receipt_line_id,movement_id,lot_id,quantity,reservations:[{reservation_id,receipt_allocation_id,purchase_allocation_id,demand_line_id,quantity}]}]}`.

`receive`, `receive_and_reserve`, `open_stock`, `reserve`, `release`, `ship`, `track_lots`, `hold_lot`, `release_hold`, `create_shipment`, `add_shipment_line`, `dispatch`, `record_tracking_event` preserve the single-line stock behavior using the same runner. Receiving/reserving use explicit locations; shipment operations resolve locations from their reservations. No production location is guessed.

The `/api/fulfillment` adapter and `/shipments.html` page expose shipment reads,
creation, reservation-backed line additions, dispatch and tracking events using
these existing commands. Read projections use a committed snapshot and account
for all draft shipment commitments. See
[Shipping workspace](shipping-workspace.md) for request shapes and supported
manual carrier references. This UI/API extension changes no stock tables or rules.

## Purchasing tables (coordination)

Implemented with purchasing agent agreement: `quote_versions`, `purchase_orders`, `purchase_order_lines`, `purchase_allocations` with immutable quotes and approved terms. Stock whole-delivery validation reads these agreed fields: `purchase_orders(id,status)`, `purchase_order_lines(id,purchase_order_id,item_id,quantity)`, `purchase_allocations(id,po_line_id,demand_line_id,quantity)`. Purchasing progress reads receipt lines and receipt allocations. Purchasing approval writes no stock records.
