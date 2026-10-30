# Shipping workspace

Open `/shipments.html` or select **Shipping** in the navigation. Connect with the
same owner development token as Purchasing. The page uses the existing private
business database and stock engine. No migration or new Supabase service is
required.

## Demo sequence

1. Select a customer order. Check its item quantities, reserved stock, location
   and quantities already assigned to draft shipments. Orders entered through
   Business setup & records show their order number, customer and address.
2. Enter a unique shipment number and select **Create draft**.
3. Select a reservation, enter the quantity and select **Add shipment line**.
   Use a partial quantity to leave stock for another shipment. Repeat for other
   reservations belonging to the same customer order.
4. Review the saved lines. Enter a carrier, dispatch date, and either a tracking
   reference or an existing label reference. Select **Dispatch shipment**.
5. Read **Inventory by location**. On-hand and reserved quantities decrease by
   the dispatched quantity. Draft creation and line addition do not move stock.
6. Record **In transit**, **Failed delivery**, **Exception** or **Delivered** as
   appropriate. Read the delivery history and the derived shipment state.
   Delivery events do not move stock. Delivered remains final even when a later
   event is recorded.

If the order has no reservations, use **Receive goods** to return to Purchasing
and receive goods with allocations for that order. This interface selects
existing reservations; it does not expose free-stock reservation or inventory
corrections. A shipment contains one customer order, and one reservation appears
at most once in that shipment. Quantities on every undispatched draft reduce
what can be assigned to another draft.

Carrier names, tracking references and label references are entered manually.
The page does not contact a carrier, buy postage or generate a label. Existing
stock commands keep draft lines and dispatched records immutable; editing,
removing or cancelling a saved line is outside this UI/API change.

## Failure and retry behavior

Inputs are locked while a command is pending. A network failure keeps the form
and its request key in memory. Retry unchanged to obtain the saved result if the
server already committed it. A successful command followed by a failed refresh
is reported as saved; retry unchanged or select **Refresh**. After refresh
succeeds, the page reloads reservations, stock and shipment details together.
Changing order or shipment restores the prior selection if its read fails.

Authorization is held only in page memory, never in browser storage or a URL.
Reload/disconnect clears it. This remains the local development login; production
OperationsNerd authentication and routing are a separate integration.

## HTTP contract

All routes begin with `/api/fulfillment` and require the existing Bearer token.
The pre-existing `/api/shipping` service remains the rate-comparison demo.

| Method and suffix | Request / result |
| --- | --- |
| GET `/workspace` | Orders and demand progress, reservations, draft planning totals, shipment summaries, stock and display references |
| GET `/shipments` | `{shipments: [...]}` with derived state and line totals |
| GET `/shipments/{id}` | Shipment, lines, reservation/location links, stock-movement traces and events |
| POST `/shipments` | `{shipment_number, order_ref, idempotency_key}` → draft (201) |
| POST `/shipments/{id}/lines` | `{reservation_id, quantity, idempotency_key}` → saved line (201) |
| POST `/shipments/{id}/dispatch` | `{carrier, as_of, tracking_ref?, label_ref?, idempotency_key}` → stock dispatch result (200) |
| POST `/shipments/{id}/events` | `{event, occurred_at, detail?, idempotency_key}` → event and derived state (201) |

`as_of` is an ISO date. `occurred_at` must include a timezone. Carrier event
values are `in_transit`, `out_for_delivery`, `delivery_failed`, `delivered` and
`exception`. Shipment states are `draft`, `dispatched`, `in_transit`, `exception`
and `delivered`. Carrier events cannot overwrite shipment status directly.

Mutations delegate to existing stock commands with their global request-key
registry, transaction and lock behavior. Missing records return 404; stale or
conflicting stock operations return 409; invalid fields/references return 422.
No endpoint accepts another business database, an approval actor, ledger writes
or arbitrary operation names. Read projections use a consistent committed
snapshot; the stock commands recheck authoritative quantities under locks.

## Verification

Shipping has HTTP-boundary tests in `tests_api/test_fulfillment_api.py` and real
PostgreSQL HTTP acceptance in `tests_postgres/test_fulfillment_api.py`. Run them
with the existing scripts:

```sh
.venv/bin/python -m unittest discover -s tests_api -v
.venv/bin/python scripts/test-postgres.py
npm test
npm run build
```

The PostgreSQL harness uses a disposable local database, not Supabase. Tests
cover purchase approval/receipt/partial dispatch, reservation planning across
drafts, mixed orders, concurrent and replayed dispatch, full rollback when a
later line fails, carrier-event histories and terminal delivery without changing
inventory.
