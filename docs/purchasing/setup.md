# Persistent purchasing workspace setup

This workspace lives entirely in LogisticsNerd. Purchasing and stock use the same PostgreSQL database. The existing order-workflow and supplier-comparison demos remain available and retain their separate fixture behavior.

The **Business setup & records** page at `/business.html` now provides the setup
questionnaire, standard entity records, customer order entry and user-created
tables with generated CRUD forms. See [Business setup and records](business-workspace.md)
for the workflow, foreign-key rules and remaining core integration boundary.

## Supabase connection

In Supabase Dashboard, open **Connect**, select **Direct / Connection string**, then choose **Session pooler**. Keep **Type: URI**. The session pooler supports IPv4, which is useful when the direct database endpoint requires IPv6. Copy the complete URI from your dashboard; do not guess the pooler hostname or region. [Supabase connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres)

Replace `[YOUR-PASSWORD]` with the database password. Percent-encode password characters that have special meaning in a URI. This is the database password, not your Supabase account password. If needed, use the dashboard’s **Reset database password** action.

Save the result locally as `LOGISTICS_DATABASE_URL` in `.env.local`. This file is ignored by Git. Do not paste the password, complete connection string, or API token into chat, screenshots, source code, or browser configuration.

```dotenv
LOGISTICS_DATABASE_URL=postgresql://<dashboard-user>:<encoded-database-password>@<dashboard-session-pooler-host>:5432/postgres?sslmode=require
LOGISTICS_BUSINESS_KEY=<one-stable-development-business-key>
LOGISTICS_ACTOR_REF=<trusted-owner-external-reference>
LOGISTICS_API_TOKEN=<long-random-owner-development-token>
```

Use the actual values prepared in the local file; the angle-bracket text above is documentation only. The project URL `https://cxwxpmspmjgpipxdjhgx.supabase.co` is an API URL, not the PostgreSQL connection string. No service-role key is needed for this server-side PostgreSQL connection.

This project represents **one business’s development database**. It must not combine several businesses by changing a browser-supplied business ID. The backend verifies the configured business key against the database identity before serving domain requests.

This setup works with the existing free-tier project. Use local disposable PostgreSQL for automated tests and local `pg_dump` exports for backup rehearsal. No paid IPv4 add-on, Supabase preview branching, point-in-time recovery, or extra cloud project is required for this development workflow. GitHub migration deployment can be configured later after the branch is pushed.

## Local runtime

From the LogisticsNerd repository directory:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-purchasing.txt
```

The migration command reads `.env.local` without displaying credentials:

```sh
.venv/bin/python -m logistics_persistence.migrate
```

Before migrating a Supabase project, inventory its existing schema and create a restorable backup. The migrations target the dedicated `logistics` schema. Do not use a development command to overwrite existing business data.

Start the API on loopback, using the ignored environment file:

```sh
.venv/bin/python -m uvicorn logistics_persistence.api:app --host 127.0.0.1 --port 8001 --env-file .env.local
```

In a second terminal:

```sh
npm run dev
```

Open `http://127.0.0.1:5173/business.html` for business setup and records, or
`http://127.0.0.1:5173/purchasing.html` for purchasing (or the port Vite prints).
Vite proxies `/api/business` and `/api/purchasing` to the loopback API. Enter the
`LOGISTICS_API_TOKEN` value from your local environment file into the connection
form. The token is held only in page memory. It is cleared on disconnect or page
close; it is never saved to local storage.

The business-record service is a standalone local adapter: it creates mapped
references for standard records and publishes demand when a customer order is
submitted. It does not let clients write arbitrary core bindings, select another
business database, supply an approval actor or create a login by adding an
employee. The production OperationsNerd item/entity mapping remains pending.
Development seed data remains explicitly synthetic and is not overwritten or
represented as a production catalog.

The configured `LOGISTICS_ACTOR_REF` must resolve to a current actor binding whose snapshot grants `can_approve_purchases: true` before purchase approval can succeed.

## Workspace workflow

1. Save a supplier quote version. Prices use integer minor units; quantities use whole units.
2. Create a purchase draft for one supplier and currency.
3. Add quote-backed purchase lines. The quote supplier/currency and exact priced quantity must match.
4. Allocate purchase quantities to customer demand lines. Specify cost shares where a budget requires them; the workspace does not invent a cost-sharing policy.
5. Review and approve. Approval adds **no stock** and freezes the approved terms and allocations.
6. Record an actual delivery. Add each physical received portion once. A portion may reserve quantities for several allocations. All receipt portions and reservations commit together or all roll back.
7. Read purchase progress and stock by location. Outstanding quantities are calculated from receipt records.

The delivery reference identifies physical goods independently of the request key. Reusing the same physical-delivery reference with a fresh key cannot create a second receipt. Distinct real deliveries need distinct references.

The page reuses a pending request key after a network failure while it stays open. It mints a new key for a new logical request. After an uncertain response, retry without editing that request; changing its content is a new request. A page reload clears its in-memory retry keys. The delivery reference remains an independent protection against recording the same physical delivery again.

## Access and deployment boundary

`LOGISTICS_API_TOKEN` is a standalone **owner development adapter**, not OperationsNerd authentication. Bind the API to loopback for this workflow. No permissive CORS policy is installed. A production host must replace the development adapter with trusted actor authorization and private-business database routing.

The API reads core references and demand; all exposed purchasing/stock writes call transactional backend commands. It exposes no raw movement CRUD. Keep database credentials server-side. Do not grant browser roles direct write access to the `logistics` schema or add that schema to Supabase’s exposed Data API schemas as an alternative command path.

GitHub integration is separate from database connectivity. Supabase CLI login is optional for the direct PostgreSQL runtime. The local branch must be pushed before GitHub can observe it. Set up either native Supabase GitHub migration deployment or repository-owned deployment later, with one migration authority. Do not select a feature branch as production unintentionally. [Supabase GitHub integration](https://supabase.com/docs/guides/deployment/branching/github-integration)

## Checks

```sh
.venv/bin/python -m unittest discover -s tests_api -v
npm test
npm run build
```

HTTP-boundary tests use an injected service and do not establish database correctness. Purchasing, stock, concurrency, idempotency, migration, and rollback acceptance require the separate real PostgreSQL tests.

## Development fixtures and database acceptance

After migration, explicitly create synthetic demo bindings and customer demand:

```sh
.venv/bin/python -m logistics_persistence.seed --demo
```

This repeatable fixture supplies a customer line for 15 chairs, opening stock of
four reserved chairs, two suppliers offering the remaining 11, and a development
approval actor. These are fixture projections, not an OperationsNerd catalog.
The API does not expose fixture-binding writes. Existing suppliers and quotes
are not overwritten by this command.

Install the development requirements and run the complete real PostgreSQL suite:

```sh
.venv/bin/python -m pip install -r requirements-purchasing-dev.txt
.venv/bin/python scripts/test-postgres.py
```

The harness creates a disposable native PostgreSQL instance on this Mac; it does
not use Supabase quotas or paid preview branches. Test resets are restricted to
an explicitly configured local `logistics_test` database. The migration CLI
makes a private business-schema export before applying checksum-verified SQL.
Exports cover `public` and `logistics`, not Supabase Auth/Storage service data.
They remain in ignored `.local-planning/backups/`. Restoration refuses an occupied
destination. Use a PostgreSQL client matching or newer than the target server.

The initial deployment uses the existing free-tier project. No paid branching,
extra hosted projects, or paid point-in-time recovery is required. Repository-owned
migration deployment is the initial migration authority; do not enable native
Supabase auto-deployment of the same migrations simultaneously.
