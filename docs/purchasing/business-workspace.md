# Business setup and records

Open `/business.html` and connect with the same local owner development token
used by the purchasing page. Credentials stay on the backend; the token stays
in page memory and is cleared on disconnect or reload.

The setup questionnaire asks for the business name, business activity, currency,
whether it keeps physical stock, and optional requirements. Requirements notes
are saved as notes; they do not silently change the schema. Completing setup
creates standard record tables for suppliers, customers, items, locations,
shippers, employees, customer orders and customer order lines. Existing
purchasing and stock data is retained.

## Working with records

The same interface creates, lists, edits, archives, restores and deletes records
in standard tables and user-created tables. Relationship fields select existing
records from their target table. Missing references, duplicate unique values,
missing required values and incorrect types are rejected by the backend.
PostgreSQL foreign keys also reject missing target rows and deletion of rows
that are still referenced.

Archive retains history and removes a record from new selections. A reference
to an archived record is retained in existing documents. If purchasing or stock
already refers to a standard record, delete is blocked; archive is the available
alternative. Employee records describe staff and do not create login accounts or
grant purchase approval rights.

Use **Create your own table** to define a new table and its fields. Supported
types are text, whole number, money in integer minor units, yes/no, date and a
relationship to an existing table. New definitions appear in the form and list
immediately. **Add a field** extends an existing table without changing code.
New required fields are rejected on tables with existing rows, because those
rows do not yet have values. Schema changes are additive in this version:
renaming, removing fields and changing types require a later migration workflow.
Tables created directly with SQL are not automatically exposed to the browser.
The current list response is limited to the first 1,000 records per table;
pagination is a future extension. Existing synthetic fixtures are not imported
into the new standard record lists. New records are available to purchasing
through the standalone adapter.

## Entering a customer order

1. Add the customer and items.
2. Create the order header with its customer, order number, address, date and
   currency.
3. Add an order-line record for each item, with quantity, selling price in minor
   units and optional required date.
4. Return to the order and select **Submit to purchasing**.

Submission publishes all active lines as customer demand in one transaction.
Retrying the same request does not publish duplicate demand. The submitted order
and lines are frozen, including at the database level. Subsequent amendment or
cancellation requires a fulfillment policy and is not implemented here. The
selling price is not treated as the customer's purchasing budget.

The purchasing page reads submitted demand and current local supplier/item
references. Quote approval, receiving, reservations and stock movements continue
through their transactional commands. The generic editor never exposes raw
ledger writes or permits editing approved purchase documents.

## Database and integration contract

Migration `202610280001_business_records.sql` adds `business_setup`,
`record_tables`, `record_fields`, `record_binding_links` and append-only
`record_events` in the private `logistics` schema. Setup and later table creation
create typed physical tables named `record_<table_slug>` in the same schema.
Reference columns have foreign keys to the specific target record table.
Metadata is used for forms, not as a substitute for physical constraints.

Only registered tables can use `/api/business/tables/.../records`. Identifiers
are validated and quoted; clients cannot select a database, role, SQL type or
arbitrary existing logistics table. Additive schema changes and CRUD share a
database lock protocol; records and definitions have optimistic versions.
Commands share purchasing and stock's durable request-key registry.

This is a standalone local business-record adapter. Supplier changes preserve
binding revisions and approved PO snapshots. Item and location identities stay
stable for existing ledger entries. Authoritative OperationsNerd keys, field
mapping and host authentication remain external integration work. Nothing in
this implementation changes the OperationsNerd repository or claims its chat
configuration is connected to these forms.

All tables remain server-only in the existing free-tier Supabase project. No
extra project, paid branching, paid IPv4 add-on or Supabase Auth migration is
required. Migrate through the existing backup-and-checksum command, then restart
the API. Test data belongs in disposable local databases, not the live ledger.
