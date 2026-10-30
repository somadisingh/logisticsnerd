# Shipping API and UI implementation plan — 30 October 2026

Status: implemented and verified. See
[shipping verification](shipping-verification-2026-10-30.md) for the actual checks.

## Scope and references

Expose LogisticsNerd's existing tested shipment commands through the authenticated
API and a browser page. Reuse `stock.create_shipment`, `add_shipment_line`,
`dispatch`, `record_tracking_event` and `shipment`. Stock tables, quantities,
transactions, locking, event-derived states and parity behavior are unchanged.
Cash accounts, stock corrections, transfers, automatic label generation and
OperationsNerd production integration are outside this change.

References inspected: current LogisticsNerd stock commands, SQL constraints and
views, purchasing/records HTTP adapters, browser authentication and retry logic;
the preserved Jasmeet stock fixture and provenance document; OperationsNerd
checkout `4ac00e6` and its owner-scoped business access in `agentic/store.py`.
OperationsNerd main does not contain the stock branch. Its source is used as a
reference; no OperationsNerd files are changed.

## Transport and reads

Use `/api/fulfillment`, separate from the existing `/api/shipping` rate-comparison
service. Register it with the current owner authentication and server-selected
private-business database dependency. Browser requests cannot supply a database,
business, actor or arbitrary stock operation.

| Route | Behavior |
| --- | --- |
| GET `/workspace` | Consistent order/demand progress, reservations, draft commitments, shipments, stock by location and display references |
| GET `/shipments` | Shipment summaries with derived state and line totals |
| GET `/shipments/{id}` | Lines, reservation/location references, dispatch evidence, posted movement traces and carrier events |
| POST `/shipments` | Create a numbered draft for an existing customer order |
| POST `/shipments/{id}/lines` | Add a quantity from one active reservation through the stock command |
| POST `/shipments/{id}/dispatch` | Dispatch every saved line atomically with a manual carrier and label/tracking reference |
| POST `/shipments/{id}/events` | Append a timezone-aware carrier event through the stock command |

All mutation requests require the existing cross-command idempotency key. Dates
and timestamps are converted consistently before entering stock commands.
Validation rejects extra authority fields, invalid integers, unknown events and
timestamps without timezone. Domain errors keep their existing HTTP status;
unexpected failures disclose no SQL, credentials or connection details.

The read adapter normalizes reservation line references to their customer-order
header. It supports both standalone business records and existing core/fixture
references. Display metadata is optional: setup is not a prerequisite for reading
existing shipments. Reservation availability equals unshipped reserved quantity
minus quantities on all undispatched drafts; it is a display projection, while
the unchanged engine enforces the authoritative limit under locks.

## Browser workflow

1. Connect with the existing development token, held in memory only.
2. Select a customer order; show demand, reserved stock and quantities already
   planned on drafts.
3. Create a shipment number and add reservation-backed lines. Each shipment
   belongs to one customer order. Partial quantities are allowed. Adding lines
   does not move inventory.
4. Review saved lines and dispatch with a carrier, date and at least one label
   or tracking reference. Reload current stock and reservation totals after the
   command. Existing draft lines are immutable; this interface adds no edit,
   delete or cancellation policy.
5. Read shipment state and record manual carrier events. Required states are
   draft, dispatched, in transit, exception and delivered. Delivered remains
   terminal; carrier events create no inventory movement.

Use named references and location labels, useful empty states and a link back to
receiving when no reserved stock exists. Match current application styling and
support mobile layouts and keyboard input. Failures retain form contents and
request identity, including when the mutation succeeded but the following refresh
failed. Disable inputs while saving and distinguish a refresh failure from an
unsaved command. Reload/disconnect clears authorization.

## Verification and delivery

- HTTP boundary tests: authentication before DB access, strict inputs, trusted
  business routing, time normalization, command delegation and sanitized errors.
- Real PostgreSQL HTTP acceptance: receipt-to-reservation-to-shipment loop,
  partial dispatch, all-draft planning totals, mixed orders, concurrent/duplicate
  dispatch protection, complete rollback on failed dispatch and terminal
  delivery status without extra stock.
- Browser acceptance on an isolated local PostgreSQL database: create/add/
  dispatch/update events, read refreshed inventory, reload/persistence, rejected
  over-quantity, retry identities and responsive layouts.
- Existing tests and production build once the interfaces are integrated.
- Read-only check against the configured Supabase project. Do not dispatch or
  seed demonstration data in its existing ledger. No migration or paid service
  is required. Restart the local API and serve the new page for the owner.
