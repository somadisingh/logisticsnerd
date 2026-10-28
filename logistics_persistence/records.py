"""Typed, owner-managed business records and additive schema configuration.

Metadata describes forms, but every record lives in a physical PostgreSQL table.
Reference fields use real foreign keys to the specific target table. Only these
registered tables are exposed; purchasing and ledger rows keep their commands.
The local binding bridge is a standalone adapter, not an OperationsNerd catalog.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
import re
from typing import Any

from psycopg import sql
from psycopg.types.json import Jsonb

from .db import json_value, run_command
from .errors import Conflict, NotFound, ValidationError

SCHEMA_LOCK = 1768842365
TYPES = {"text": "text", "integer": "bigint", "money": "bigint",
         "boolean": "boolean", "date": "date", "reference": "bigint"}
RESERVED = {"id", "version", "archived", "created_at", "updated_at", "system", "values"}
RESERVED_TABLES = {"tables", "fields", "events", "binding_links", "stock_movements",
    "command_requests", "core_bindings", "schema_migrations", "database_identity",
    "business_setup", "record_tables", "record_fields", "record_events", "record_binding_links",
    "purchase_orders", "purchase_order_lines", "purchase_allocations", "quote_versions",
    "demand_lines", "stock_resources", "stock_reservations", "stock_lots", "stock_lot_tracking",
    "stock_lot_holds", "receipts", "receipt_lines", "receipt_allocations", "lot_allocations",
    "shipments", "shipment_lines", "shipment_events", "shipment_dispatches"}
BINDING_ROLES = {"supplier", "customer", "item", "location", "carrier"}


def _field(slug, label, type="text", **options):
    return dict(slug=slug, label=label, type=type, **options)


STANDARD_TABLES = [
    ("suppliers", "Suppliers", "supplier", [
        _field("name", "Name", required=True), _field("email", "Email"),
        _field("phone", "Phone"), _field("address", "Address"), _field("contact_name", "Contact name")]),
    ("customers", "Customers", "customer", [
        _field("name", "Name", required=True), _field("email", "Email"),
        _field("phone", "Phone"), _field("address", "Address")]),
    ("items", "Items", "item", [
        _field("sku", "SKU", required=True, unique=True), _field("name", "Name", required=True),
        _field("description", "Description"), _field("unit", "Unit")]),
    ("locations", "Locations", "location", [
        _field("name", "Name", required=True), _field("address", "Address")]),
    ("carriers", "Shippers", "carrier", [
        _field("name", "Name", required=True), _field("transport_options", "Transport options"),
        _field("email", "Email"), _field("phone", "Phone")]),
    ("employees", "Employees", "employee", [
        _field("name", "Name", required=True), _field("email", "Email"), _field("role", "Job role")]),
    ("customer_orders", "Customer orders", "customer_order", [
        _field("order_number", "Order number", required=True, unique=True),
        _field("customer_id", "Customer", "reference", required=True, target_table="customers"),
        _field("ship_to_address", "Ship to address"), _field("order_date", "Order date", "date", required=True),
        _field("currency", "Currency", required=True)]),
    ("customer_order_lines", "Customer order lines", "customer_order_line", [
        _field("order_id", "Customer order", "reference", required=True, target_table="customer_orders"),
        _field("item_id", "Item", "reference", required=True, target_table="items"),
        _field("quantity", "Quantity", "integer", required=True, min_value=1),
        _field("unit_price_minor", "Unit price (minor units)", "money", required=True, min_value=0),
        _field("required_by", "Required by", "date")]),
]


def _slug(value, label="Name"):
    if type(value) is not str or not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", value) or value in RESERVED:
        raise ValidationError(f"{label} must start with a lowercase letter and contain up to 40 lowercase letters, digits or underscores")
    return value


def _label(value):
    if type(value) is not str or not value.strip() or len(value.strip()) > 120:
        raise ValidationError("A label must contain 1 through 120 characters")
    return value.strip()


def _positive(value, label):
    if type(value) is not int or value < 1:
        raise ValidationError(f"{label} must be a positive integer")


def _table_name(table):
    return sql.Identifier("logistics", "record_" + table["slug"])


def _table(conn, slug):
    _slug(slug, "Table name")
    row = conn.execute("SELECT * FROM logistics.record_tables WHERE slug=%s", (slug,)).fetchone()
    if row is None:
        raise NotFound("Business table does not exist")
    return row


def _fields(conn, table):
    rows = conn.execute("""SELECT f.slug,f.label,f.type,f.required,f.is_unique AS unique,
        t.slug AS target_table,f.min_value FROM logistics.record_fields f
        LEFT JOIN logistics.record_tables t ON t.id=f.target_table_id
        WHERE f.table_id=%s ORDER BY f.position,f.id""", (table["id"],)).fetchall()
    return [dict(row) for row in rows]


def _describe(conn, table):
    return {key: table[key] for key in ("slug", "label", "role", "version")} | {"fields": _fields(conn, table)}


def catalog(conn):
    setup = conn.execute("SELECT * FROM logistics.business_setup WHERE singleton=true").fetchone()
    tables = conn.execute("SELECT * FROM logistics.record_tables ORDER BY id").fetchall()
    return {"setup": json_value(dict(setup)) if setup else None,
            "tables": [_describe(conn, table) for table in tables],
            "integration": {"mode": "standalone-local-records", "core_mapping": "pending-OperationsNerd-contract",
                "database": "one-private-business", "schema_changes": "additive-only",
                "purchasing_and_stock": "controlled-commands", "employee_authorization": "employees-do-not-grant-access"}}


def _normalize_field(conn, field):
    if type(field) is not dict or set(field) - {"slug", "label", "type", "required", "unique", "target_table", "min_value"}:
        raise ValidationError("Field definition contains unknown properties")
    name = _slug(field.get("slug"), "Field name")
    label = _label(field.get("label"))
    kind = field.get("type", "text")
    if type(kind) is not str or kind not in TYPES:
        raise ValidationError("Unknown field type")
    required, unique = field.get("required", False), field.get("unique", False)
    if type(required) is not bool or type(unique) is not bool:
        raise ValidationError("Required and unique options must be true or false")
    target = field.get("target_table")
    target_row = _table(conn, target) if kind == "reference" else None
    if kind != "reference" and target is not None:
        raise ValidationError("Only reference fields can select a target table")
    minimum = field.get("min_value")
    if minimum is not None and (kind not in {"integer", "money"} or type(minimum) is not int or not -(2**63) <= minimum < 2**63):
        raise ValidationError("Minimum value requires an integer or money field and a whole number")
    if kind == "money" and minimum is None:
        minimum = 0
    return dict(slug=name, label=label, type=kind, required=required, unique=unique,
                target_table=target, target_id=target_row["id"] if target_row else None, min_value=minimum)


def _install_field(conn, table, field, position):
    spec = _normalize_field(conn, field)
    column = sql.SQL("{} {}").format(sql.Identifier(spec["slug"]), sql.SQL(TYPES[spec["type"]]))
    if spec["required"]:
        column += sql.SQL(" NOT NULL")
    if spec["unique"]:
        column += sql.SQL(" UNIQUE")
    if spec["type"] == "reference":
        column += sql.SQL(" REFERENCES {}(id) ON DELETE RESTRICT").format(
            sql.Identifier("logistics", "record_" + spec["target_table"]))
    if spec["type"] == "text":
        column += sql.SQL(" CHECK({0} IS NULL OR (length({0})<=10000{1}))").format(
            sql.Identifier(spec["slug"]), sql.SQL(" AND length(trim({}))>0").format(sql.Identifier(spec["slug"])) if spec["required"] else sql.SQL(""))
    if spec["min_value"] is not None:
        column += sql.SQL(" CHECK({} >= {})").format(sql.Identifier(spec["slug"]), sql.Literal(spec["min_value"]))
    conn.execute(sql.SQL("ALTER TABLE {} ADD COLUMN ").format(_table_name(table)) + column)
    if spec["type"] == "reference" and not spec["unique"]:
        conn.execute(sql.SQL("CREATE INDEX {} ON {} ({})").format(
            sql.Identifier(f"record_reference_{table['id']}_{position}"), _table_name(table), sql.Identifier(spec["slug"])))
    conn.execute("""INSERT INTO logistics.record_fields
        (table_id,slug,label,type,required,is_unique,target_table_id,min_value,position)
        VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (table["id"], spec["slug"], spec["label"], spec["type"], spec["required"], spec["unique"], spec["target_id"], spec["min_value"], position))


def _create_table(conn, slug, label, fields, role="custom"):
    _slug(slug, "Table name")
    if slug in RESERVED_TABLES:
        raise ValidationError("This table name is reserved for system records")
    label = _label(label)
    if type(fields) is not list or not 1 <= len(fields) <= 50:
        raise ValidationError("A new table needs 1 through 50 fields")
    table = dict(conn.execute("INSERT INTO logistics.record_tables(slug,label,role) VALUES(%s,%s,%s) RETURNING *", (slug, label, role)).fetchone())
    extra = sql.SQL("")
    if role in BINDING_ROLES:
        extra = sql.SQL(", _binding_id bigint UNIQUE REFERENCES logistics.core_bindings(id)")
    elif role == "customer_order":
        extra = sql.SQL(", _submitted_at timestamptz")
    elif role == "customer_order_line":
        extra = sql.SQL(", _demand_id bigint UNIQUE REFERENCES logistics.demand_lines(id)")
    conn.execute(sql.SQL("""CREATE TABLE {} (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        version integer NOT NULL DEFAULT 1 CHECK(version>0),
        archived boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(){}
        )""").format(_table_name(table), extra))
    for index, field in enumerate(fields):
        _install_field(conn, table, field, index)
    if role == "customer_order":
        conn.execute(sql.SQL("ALTER TABLE {} ADD CHECK(currency ~ '^[A-Z]{{3}}$')").format(_table_name(table)))
        conn.execute(sql.SQL("CREATE TRIGGER order_submission_guard BEFORE UPDATE OR DELETE ON {} FOR EACH ROW EXECUTE FUNCTION logistics.guard_submitted_customer_order()").format(_table_name(table)))
    elif role == "customer_order_line":
        conn.execute(sql.SQL("CREATE TRIGGER order_line_submission_guard BEFORE INSERT OR UPDATE OR DELETE ON {} FOR EACH ROW EXECUTE FUNCTION logistics.guard_submitted_customer_line()").format(_table_name(table)))
    # Tables are server-only even if Supabase adds default grants in the project.
    for role_name in ("anon", "authenticated"):
        if conn.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role_name,)).fetchone():
            conn.execute(sql.SQL("REVOKE ALL ON {} FROM {}").format(_table_name(table), sql.Identifier(role_name)))
    return _describe(conn, table)


def configure(conn, *, business_name, currency, idempotency_key, business_type="", uses_inventory=True, setup_notes=""):
    if type(business_name) is not str or not business_name.strip() or len(business_name) > 200:
        raise ValidationError("Enter a business name of up to 200 characters")
    if type(currency) is not str or not re.fullmatch(r"[A-Z]{3}", currency):
        raise ValidationError("Currency must be an uppercase three-letter code")
    if type(uses_inventory) is not bool or type(business_type) is not str or type(setup_notes) is not str or len(business_type) > 200 or len(setup_notes) > 10000:
        raise ValidationError("Check the business type, inventory choice and notes")
    payload = dict(business_name=business_name, currency=currency, business_type=business_type,
                   uses_inventory=uses_inventory, setup_notes=setup_notes)
    def work(c):
        c.execute("SELECT pg_advisory_xact_lock(%s,1)", (SCHEMA_LOCK,))
        c.execute("""INSERT INTO logistics.business_setup(singleton,business_name,currency,business_type,uses_inventory,setup_notes)
            VALUES(true,%s,%s,%s,%s,%s) ON CONFLICT(singleton) DO UPDATE SET business_name=EXCLUDED.business_name,
            currency=EXCLUDED.currency,business_type=EXCLUDED.business_type,uses_inventory=EXCLUDED.uses_inventory,
            setup_notes=EXCLUDED.setup_notes,version=business_setup.version+1,updated_at=now()""",
            (business_name.strip(), currency, business_type.strip(), uses_inventory, setup_notes.strip()))
        for slug, label, role, fields in STANDARD_TABLES:
            if not c.execute("SELECT 1 FROM logistics.record_tables WHERE slug=%s", (slug,)).fetchone():
                _create_table(c, slug, label, fields, role)
        return catalog(c)
    return run_command(conn, "records.configure", idempotency_key, payload, work)


def create_table(conn, *, slug, label, fields, idempotency_key):
    def work(c):
        c.execute("SELECT pg_advisory_xact_lock(%s,1)", (SCHEMA_LOCK,))
        if not c.execute("SELECT 1 FROM logistics.business_setup").fetchone():
            raise ValidationError("Complete business setup before adding tables")
        if slug in {table[0] for table in STANDARD_TABLES}:
            raise ValidationError("This table name is reserved for a standard business entity")
        return {"table": _create_table(c, slug, label, fields)}
    return run_command(conn, "records.create_table", idempotency_key, dict(slug=slug, label=label, fields=fields), work)


def add_field(conn, *, table_slug, field, expected_version, idempotency_key):
    def work(c):
        c.execute("SELECT pg_advisory_xact_lock(%s,1)", (SCHEMA_LOCK,))
        table = _table(c, table_slug)
        _positive(expected_version, "Expected table version")
        if table["version"] != expected_version:
            raise Conflict("Table definition changed; reload before adding the field")
        fields = _fields(c, table)
        if len(fields) >= 50:
            raise ValidationError("A table can contain up to 50 user fields")
        spec = _normalize_field(c, field)
        if any(existing["slug"] == spec["slug"] for existing in fields):
            raise Conflict("This field already exists")
        if spec["required"] and c.execute(sql.SQL("SELECT 1 FROM {} LIMIT 1").format(_table_name(table))).fetchone():
            raise ValidationError("Add this field as optional first: existing records have no value")
        _install_field(c, table, field, len(fields))
        c.execute("UPDATE logistics.record_tables SET version=version+1 WHERE id=%s", (table["id"],))
        return {"table": _describe(c, _table(c, table_slug))}
    return run_command(conn, "records.add_field", idempotency_key,
                       dict(table_slug=table_slug, field=field, expected_version=expected_version), work)


def _record(conn, table, record_id, *, lock=False):
    _positive(record_id, "Record ID")
    row = conn.execute(sql.SQL("SELECT * FROM {} WHERE id=%s{}").format(_table_name(table), sql.SQL(" FOR UPDATE" if lock else "")), (record_id,)).fetchone()
    if row is None:
        raise NotFound("Record does not exist")
    return dict(row)


def _present(conn, table, row, fields=None):
    system = {}
    if table["role"] in BINDING_ROLES:
        system["core_binding_id"] = row.get("_binding_id")
    if table["role"] == "customer_order":
        system.update(status="submitted" if row.get("_submitted_at") else "draft", submitted_at=row.get("_submitted_at"))
    if table["role"] == "customer_order_line":
        system["demand_line_id"] = row.get("_demand_id")
    return json_value({"id": row["id"], "version": row["version"], "archived": row["archived"],
        "values": {field["slug"]: row.get(field["slug"]) for field in (fields if fields is not None else _fields(conn, table))}, "system": system})


def list_records(conn, table_slug, include_archived=False):
    if type(include_archived) is not bool:
        raise ValidationError("Archived filter must be true or false")
    table = _table(conn, table_slug)
    fields = _fields(conn, table)
    rows = conn.execute(sql.SQL("SELECT * FROM {} {} ORDER BY id LIMIT 1000").format(_table_name(table), sql.SQL("" if include_archived else "WHERE NOT archived"))).fetchall()
    return {"records": [_present(conn, table, dict(row), fields) for row in rows]}


def get_record(conn, table_slug, record_id):
    table = _table(conn, table_slug)
    return {"record": _present(conn, table, _record(conn, table, record_id))}


def _values(conn, table, values, old=None):
    if type(values) is not dict:
        raise ValidationError("Record values must be an object")
    fields = _fields(conn, table)
    allowed = {field["slug"] for field in fields}
    if set(values) - allowed:
        raise ValidationError("Record contains an unknown or system field")
    result = {}
    for field in fields:
        name = field["slug"]
        value = values.get(name, old.get(name) if old else None)
        if value is None or value == "":
            if field["required"]:
                raise ValidationError(f"{field['label']} is required")
            result[name] = None
            continue
        kind = field["type"]
        if kind == "text":
            if type(value) is not str or len(value) > 10000:
                raise ValidationError(f"{field['label']} must be text of up to 10000 characters")
            value = value.strip()
            if field["required"] and not value:
                raise ValidationError(f"{field['label']} is required")
        elif kind in {"integer", "money", "reference"}:
            if type(value) is not int or not -(2**63) <= value < 2**63:
                raise ValidationError(f"{field['label']} must be a whole number")
            if field["min_value"] is not None and value < field["min_value"]:
                raise ValidationError(f"{field['label']} is below its minimum value")
            if kind == "reference":
                _positive(value, field["label"])
                target = _table(conn, field["target_table"])
                referenced = conn.execute(sql.SQL("SELECT archived FROM {} WHERE id=%s FOR SHARE").format(_table_name(target)), (value,)).fetchone()
                if referenced is None or referenced["archived"]:
                    raise ValidationError(f"{field['label']} must refer to an existing active {target['label']} record")
        elif kind == "boolean":
            if type(value) is not bool:
                raise ValidationError(f"{field['label']} must be true or false")
        elif kind == "date":
            if type(value) is str:
                try:
                    value = date.fromisoformat(value)
                except ValueError:
                    raise ValidationError(f"{field['label']} must be an ISO calendar date") from None
            if type(value) is not date:
                raise ValidationError(f"{field['label']} must be a calendar date")
        result[name] = value
    if table["role"] == "customer_order" and not re.fullmatch(r"[A-Z]{3}", result["currency"]):
        raise ValidationError("Order currency must be an uppercase three-letter code")
    return result


def _bridge(conn, table, row, *, revised=False):
    if table["role"] not in BINDING_ROLES:
        return row
    old_binding = row.get("_binding_id")
    if old_binding is not None and (table["role"] != "supplier" or not revised):
        return row
    snapshot = json_value({field["slug"]: row.get(field["slug"]) for field in _fields(conn, table)})
    snapshot.update(local_table=table["slug"], local_record_id=row["id"], mapping_status="standalone-local-record")
    now = datetime.now(timezone.utc)
    if old_binding is not None:
        conn.execute("UPDATE logistics.core_bindings SET valid_to=%s WHERE id=%s", (now, old_binding))
    binding = conn.execute("""INSERT INTO logistics.core_bindings(kind,external_key,snapshot,valid_from)
        VALUES(%s,%s,%s,%s) RETURNING id""", (table["role"], f"local:{table['slug']}:{row['id']}", Jsonb(snapshot), now)).fetchone()
    conn.execute("INSERT INTO logistics.record_binding_links(binding_id,table_id,record_id) VALUES(%s,%s,%s)", (binding["id"], table["id"], row["id"]))
    conn.execute(sql.SQL("UPDATE {} SET _binding_id=%s WHERE id=%s").format(_table_name(table)), (binding["id"], row["id"]))
    return _record(conn, table, row["id"])


def _audit(conn, table, row, event, key):
    conn.execute("INSERT INTO logistics.record_events(table_id,record_id,event,snapshot,request_key) VALUES(%s,%s,%s,%s,%s)",
                 (table["id"], row["id"], event, Jsonb(_present(conn, table, row)), key))


def _mutable(conn, table, row):
    if table["role"] == "customer_order" and row.get("_submitted_at"):
        raise Conflict("Submitted customer orders are frozen; cancellation requires a fulfillment contract")
    if table["role"] == "customer_order_line":
        parent = conn.execute("SELECT _submitted_at FROM logistics.record_customer_orders WHERE id=%s FOR UPDATE", (row["order_id"],)).fetchone()
        if parent and parent["_submitted_at"]:
            raise Conflict("Submitted customer order lines are frozen")


def _check_version(row, expected_version):
    _positive(expected_version, "Expected record version")
    if row["version"] != expected_version:
        raise Conflict("Record changed; reload before saving")


def create_record(conn, *, table_slug, values, idempotency_key):
    def work(c):
        c.execute("SELECT pg_advisory_xact_lock_shared(%s,1)", (SCHEMA_LOCK,))
        table = _table(c, table_slug)
        normalized = _values(c, table, values)
        if table["role"] == "customer_order_line":
            _mutable(c, table, normalized)
        columns = list(normalized)
        row = dict(c.execute(sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING *").format(
            _table_name(table), sql.SQL(",").join(map(sql.Identifier, columns)),
            sql.SQL(",").join(sql.Placeholder() for _ in columns)), tuple(normalized.values())).fetchone())
        row = _bridge(c, table, row)
        _audit(c, table, row, "created", idempotency_key)
        return {"record": _present(c, table, row)}
    return run_command(conn, "records.create_record", idempotency_key, dict(table_slug=table_slug, values=values), work)


def update_record(conn, *, table_slug, record_id, values, expected_version, idempotency_key):
    def work(c):
        c.execute("SELECT pg_advisory_xact_lock_shared(%s,1)", (SCHEMA_LOCK,))
        table = _table(c, table_slug)
        row = _record(c, table, record_id, lock=True)
        _check_version(row, expected_version)
        _mutable(c, table, row)
        if row["archived"]:
            raise Conflict("Restore the record before editing it")
        normalized = _values(c, table, values, row)
        if table["role"] == "customer_order_line":
            _mutable(c, table, normalized)
        assignments = [sql.SQL("{}=%s").format(sql.Identifier(key)) for key in normalized]
        c.execute(sql.SQL("UPDATE {} SET {},version=version+1,updated_at=now() WHERE id=%s").format(_table_name(table), sql.SQL(",").join(assignments)), (*normalized.values(), record_id))
        new = _bridge(c, table, _record(c, table, record_id), revised=any(row.get(key) != value for key, value in normalized.items()))
        _audit(c, table, new, "updated", idempotency_key)
        return {"record": _present(c, table, new)}
    return run_command(conn, "records.update_record", idempotency_key,
        dict(table_slug=table_slug, record_id=record_id, values=values, expected_version=expected_version), work)


def archive_record(conn, *, table_slug, record_id, archived, expected_version, idempotency_key):
    if type(archived) is not bool:
        raise ValidationError("Archive choice must be true or false")
    def work(c):
        c.execute("SELECT pg_advisory_xact_lock_shared(%s,1)", (SCHEMA_LOCK,))
        table = _table(c, table_slug)
        row = _record(c, table, record_id, lock=True)
        _check_version(row, expected_version)
        _mutable(c, table, row)
        c.execute(sql.SQL("UPDATE {} SET archived=%s,version=version+1,updated_at=now() WHERE id=%s").format(_table_name(table)), (archived, record_id))
        new = _record(c, table, record_id)
        _audit(c, table, new, "archived" if archived else "restored", idempotency_key)
        return {"record": _present(c, table, new)}
    return run_command(conn, "records.archive_record", idempotency_key,
        dict(table_slug=table_slug, record_id=record_id, archived=archived, expected_version=expected_version), work)


def _referenced(conn, relation, record_id, *, skip_managed=False):
    constraints = conn.execute("""SELECT ns.nspname AS schema_name,cls.relname AS table_name,attr.attname AS column_name
        FROM pg_constraint con JOIN pg_class cls ON cls.oid=con.conrelid
        JOIN pg_namespace ns ON ns.oid=cls.relnamespace
        JOIN pg_attribute attr ON attr.attrelid=con.conrelid AND attr.attnum=con.conkey[1]
        WHERE con.contype='f' AND con.confrelid=to_regclass(%s) AND cardinality(con.conkey)=1""", (relation,)).fetchall()
    for entry in constraints:
        if skip_managed and (entry["table_name"].startswith("record_") or entry["table_name"] == "core_bindings"):
            continue
        if conn.execute(sql.SQL("SELECT 1 FROM {} WHERE {}=%s LIMIT 1").format(
                sql.Identifier(entry["schema_name"], entry["table_name"]), sql.Identifier(entry["column_name"])), (record_id,)).fetchone():
            return True
    return False


def delete_record(conn, *, table_slug, record_id, expected_version, idempotency_key):
    def work(c):
        c.execute("SELECT pg_advisory_xact_lock_shared(%s,1)", (SCHEMA_LOCK,))
        table = _table(c, table_slug)
        row = _record(c, table, record_id, lock=True)
        _check_version(row, expected_version)
        _mutable(c, table, row)
        if _referenced(c, "logistics.record_" + table["slug"], record_id):
            raise Conflict("Other records refer to this record; archive it instead")
        for link in c.execute("SELECT binding_id FROM logistics.record_binding_links WHERE table_id=%s AND record_id=%s", (table["id"], record_id)).fetchall():
            if _referenced(c, "logistics.core_bindings", link["binding_id"], skip_managed=True):
                raise Conflict("Purchasing or stock refers to this record; archive it instead")
        _audit(c, table, row, "deleted", idempotency_key)
        c.execute(sql.SQL("DELETE FROM {} WHERE id=%s").format(_table_name(table)), (record_id,))
        return {"deleted": True, "record": _present(c, table, row)}
    return run_command(conn, "records.delete_record", idempotency_key,
        dict(table_slug=table_slug, record_id=record_id, expected_version=expected_version), work)


def submit_customer_order(conn, *, record_id, expected_version, idempotency_key):
    def work(c):
        c.execute("SELECT pg_advisory_xact_lock_shared(%s,1)", (SCHEMA_LOCK,))
        table = _table(c, "customer_orders")
        order = _record(c, table, record_id, lock=True)
        _check_version(order, expected_version)
        _mutable(c, table, order)
        if order["archived"]:
            raise Conflict("Restore this order before submitting it")
        customer = c.execute("SELECT archived FROM logistics.record_customers WHERE id=%s FOR SHARE", (order["customer_id"],)).fetchone()
        if customer is None or customer["archived"]:
            raise ValidationError("The order customer must be active")
        lines = c.execute("SELECT * FROM logistics.record_customer_order_lines WHERE order_id=%s AND NOT archived ORDER BY id FOR UPDATE", (record_id,)).fetchall()
        if not lines:
            raise ValidationError("Add at least one active line before submitting the order")
        demands = []
        line_table = _table(c, "customer_order_lines")
        for line in lines:
            item = c.execute("SELECT * FROM logistics.record_items WHERE id=%s FOR SHARE", (line["item_id"],)).fetchone()
            if item is None or item["archived"] or item["_binding_id"] is None:
                raise ValidationError("Each order line must reference an active item")
            demand = c.execute("""INSERT INTO logistics.demand_lines
                (external_key,order_ref,item_id,quantity,currency,required_by)
                VALUES(%s,%s,%s,%s,%s,%s) RETURNING *""",
                (f"local:customer_order_lines:{line['id']}", f"local:customer_orders:{record_id}",
                 item["_binding_id"], line["quantity"], order["currency"], line["required_by"])).fetchone()
            c.execute("UPDATE logistics.record_customer_order_lines SET _demand_id=%s,version=version+1,updated_at=now() WHERE id=%s", (demand["id"], line["id"]))
            _audit(c, line_table, _record(c, line_table, line["id"]), "submitted", idempotency_key)
            demands.append(dict(demand))
        c.execute("UPDATE logistics.record_customer_orders SET _submitted_at=now(),version=version+1,updated_at=now() WHERE id=%s", (record_id,))
        new = _record(c, table, record_id)
        _audit(c, table, new, "submitted", idempotency_key)
        return {"record": _present(c, table, new), "demands": json_value(demands)}
    return run_command(conn, "records.submit_customer_order", idempotency_key,
        dict(record_id=record_id, expected_version=expected_version), work)


def decorate_references(conn, references):
    """Overlay current local display fields without rewriting immutable bindings."""
    if conn.execute("SELECT to_regclass('logistics.record_binding_links') AS name").fetchone()["name"] is None:
        return references
    if not references:
        return references
    owners = conn.execute("""SELECT t.*,l.record_id,l.binding_id FROM logistics.record_binding_links l
        JOIN logistics.record_tables t ON t.id=l.table_id WHERE l.binding_id=ANY(%s)""",
        ([entry["id"] for entry in references],)).fetchall()
    by_binding = {owner["binding_id"]: owner for owner in owners}
    by_table = {}
    for owner in owners:
        by_table.setdefault(owner["id"], []).append(owner)
    records, field_cache = {}, {}
    for table_id, table_owners in by_table.items():
        table = table_owners[0]
        field_cache[table_id] = _fields(conn, table)
        records[table_id] = {row["id"]: row for row in conn.execute(
            sql.SQL("SELECT * FROM {} WHERE id=ANY(%s)").format(_table_name(table)),
            ([owner["record_id"] for owner in table_owners],)).fetchall()}
    result = []
    for binding in references:
        entry = dict(binding)
        owner = by_binding.get(entry["id"])
        if owner:
            local = records[owner["id"]].get(owner["record_id"])
            if local is None or local["archived"]:
                entry["local_archived"] = True
            else:
                # Approved supplier terms refer to the exact historic snapshot.
                if entry["kind"] != "supplier" or entry.get("valid_to") is None:
                    entry["snapshot"] = dict(entry["snapshot"]) | {field["slug"]: local[field["slug"]] for field in field_cache[owner["id"]]}
                entry["local_archived"] = False
        result.append(entry)
    return result
