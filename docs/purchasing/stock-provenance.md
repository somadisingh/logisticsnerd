# PostgreSQL stock port provenance

Behavior baseline: AmaanIlahi/OperationsNerd, branch `jasmeet/logistics-stock`, commit `68554a10c43959779ebce0089f93a4eeec7a7635` (`modules/logistics/stock.py` and `schema.sql`). Jasmeet owns the original stock design. OperationsNerd was read only during this port; all implementation is in LogisticsNerd.

The port retains immutable ledger movements, derived on-hand/reserved/available quantities, partial reserve/release/ship, opening stock, opt-in lot tracking before first movement, FEFO reservation (non-expiring lots last), held/expired-lot checks, immutable shipment dispatch and tracking records, recalls, and retries through one cross-command registry. Quantities remain integral units.

Deliberate changes:

- PostgreSQL row/advisory locks replace SQLite `BEGIN IMMEDIATE`; stock resources contain lock identities, not balances. Every stock write for an item obtains the same transaction advisory lock. The database's insert triggers repeat the resource and quantity checks for direct SQL writers.
- The single `command_requests` table covers purchasing and stock. Internal helpers never commit. Child records have their own identities; several movements/reservations can share the enclosing command key.
- Core-bound location references are explicit; omission is permitted only when one current location binding exists. Item/location bindings are validated by the database.
- Receipt headers/lines and explicit purchase allocation links replace inference through a shared key. `receive_delivery` processes all physical portions and reservations together, after purchasing validates approval and remaining quantities in that same transaction.
- `delivery_ref` is a physical delivery identity unique separately from the request key. Distinct valid partial deliveries need distinct delivery references.
- Shipment views report draft, dispatched, in_transit, delivered, exception. Any delivered event makes delivered terminal; other events use occurrence time then event ID. Tracking does not write stock.
- A shipment holds lines from only one customer order, using the adapter's order header reference when present.
- The existing frontend demo remains separate from the persistent backend.

This is a source port and expanded implementation, not a statement that upstream Jasmeet built the new whole-delivery API. Production core identity mapping and migration of real SQLite data require the authoritative adapter and a verified backup/import rehearsal.

Executable upstream baseline: `tests_postgres/fixtures/jasmeet_stock_68554a1/` retains the two source files verbatim. Three parity tests in `tests_postgres/test_stock_parity.py` run both engines on opening/reserve/partial-shipment/release/replay, FEFO/hold/expiry/recall, and receive-and-reserve/shipment/delivery flows. PostgreSQL-only whole-delivery/concurrency tests remain separate.
