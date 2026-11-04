# Lot risk queue

`GET /api/purchasing/lot-risks?as_of=2026-11-04&horizon_days=30`
uses the same owner development bearer token and pinned business database as the
other purchasing endpoints. Optional positive `item_id` and `location_id` filter
before aggregation. The horizon is 0..366 days, default 30.

This is a read-only queue from the current ledger, not a historical inventory
snapshot. `as_of` classifies expiration only. It does not reverse later shipments.
A lot expiring on `as_of` remains usable that day, matching reservation policy.
The horizon end is inclusive. Nonexpiring lots appear only when held; depleted
lots do not appear. Held overrides expired, which overrides expiring, so category
on-hand totals never double-count physical units. Allocation and movement sums
are scoped to each location, including partial shipments. Allocated units remain
visible as risk; the queue does not release reservations or order replacements.

The response carries `balance_basis: current`, classification dates, per-lot
on-hand/allocated/unallocated/usable_available, and `on_hand_by_risk` totals.
Held and expired lots have zero usable availability. Unknown item/location filters
return an empty queue. This endpoint makes no writes and does not need an
idempotency key. It inherits the documented local authentication adapter limits;
it is not a replacement for production multi-tenant routing.
