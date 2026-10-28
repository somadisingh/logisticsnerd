"""User-defined records and business setup against a real PostgreSQL database.

These tests exercise the same CRUD commands for installed and newly added
tables.  No cloud database or saved development credential is used.
"""
from datetime import date, datetime, timedelta, timezone

import psycopg

from logistics_persistence import records as r, purchasing as p
from logistics_persistence.errors import LogisticsError, IdempotencyConflict
from tests_postgres.common import PostgresCase


class BusinessRecordsTests(PostgresCase):
    def setUp(self):
        super().setUp()
        self.setup = r.configure(
            self.conn, business_name="Example Toy Shop", currency="USD",
            business_type="Toy retailer", uses_inventory=True,
            setup_notes="One warehouse; wholesale and retail orders",
            idempotency_key="configure-business")

    def create(self, table, values, **options):
        return r.create_record(self.conn, table_slug=table, values=values,
                               idempotency_key=options.pop("idempotency_key", self.key("create")),
                               **options)["record"]

    def update(self, table, row, values, **options):
        return r.update_record(
            self.conn, table_slug=table, record_id=row["id"], values=values,
            expected_version=options.pop("expected_version", row["version"]),
            idempotency_key=options.pop("idempotency_key", self.key("update")),
            **options)["record"]

    def delete(self, table, row, **options):
        return r.delete_record(
            self.conn, table_slug=table, record_id=row["id"],
            expected_version=options.pop("expected_version", row["version"]),
            idempotency_key=options.pop("idempotency_key", self.key("delete")),
            **options)

    def archive(self, table, row, **options):
        return r.archive_record(
            self.conn, table_slug=table, record_id=row["id"],
            archived=options.pop("archived", True),
            expected_version=options.pop("expected_version", row["version"]),
            idempotency_key=options.pop("idempotency_key", self.key("archive")),
            **options)

    def all(self, table, **options):
        return r.list_records(self.conn, table_slug=table, **options)["records"]

    def custom_table(self, slug="equipment", fields=None):
        return r.create_table(
            self.conn, slug=slug, label="Equipment",
            fields=fields or [
                {"slug": "name", "label": "Name", "type": "text", "required": True, "unique": True},
                {"slug": "quantity", "label": "Quantity", "type": "integer", "min_value": 0},
                {"slug": "supplier", "label": "Supplier", "type": "reference", "target_table": "suppliers"},
            ], idempotency_key=self.key("table"))

    def draft_order(self, *, two_items=False):
        customer = self.create("customers", {"name": "Customer A"})
        item = self.create("items", {"name": "Wooden train", "sku": "TRAIN"})
        order = self.create("customer_orders", {
            "order_number": "SO-1001", "customer_id": customer["id"],
            "order_date": date.today().isoformat(), "currency": "USD",
            "ship_to_address": "1 Example Street"})
        lines = [self.create("customer_order_lines", {
            "order_id": order["id"], "item_id": item["id"],
            "quantity": 3, "unit_price_minor": 1500,
            "required_by": (date.today() + timedelta(days=14)).isoformat()})]
        items = [item]
        if two_items:
            second = self.create("items", {"name": "Teddy bear", "sku": "BEAR"})
            lines.append(self.create("customer_order_lines", {
                "order_id": order["id"], "item_id": second["id"],
                "quantity": 2, "unit_price_minor": 900}))
            items.append(second)
        return order, lines, items

    def test_setup_installs_standard_tables_and_replays_without_duplicate_schema(self):
        catalog = r.catalog(self.conn)
        self.assertEqual(catalog["setup"]["business_name"], "Example Toy Shop")
        self.assertEqual(catalog["setup"]["currency"], "USD")
        expected = {"suppliers", "customers", "items", "locations", "carriers", "employees",
                    "customer_orders", "customer_order_lines"}
        self.assertTrue(expected.issubset({table["slug"] for table in catalog["tables"]}))
        replay = r.configure(
            self.conn, business_name="Example Toy Shop", currency="USD",
            business_type="Toy retailer", uses_inventory=True,
            setup_notes="One warehouse; wholesale and retail orders",
            idempotency_key="configure-business")
        self.assertEqual(replay, self.setup)
        self.assertEqual(r.catalog(self.conn), catalog)
        with self.assertRaises(IdempotencyConflict):
            r.configure(self.conn, business_name="Different business", currency="USD",
                        idempotency_key="configure-business")

    def test_new_table_uses_complete_existing_crud_path(self):
        self.custom_table()
        supplier = self.create("suppliers", {"name": "Workshop Supplies"})
        first = self.create("equipment", {"name": "Packing bench", "quantity": 2, "supplier": supplier["id"]})
        self.assertEqual(self.all("equipment"), [first])
        changed = self.update("equipment", first, {"name": "Packing bench", "quantity": 3,
                                                    "supplier": supplier["id"]})
        self.assertGreater(changed["version"], first["version"])
        self.assertEqual(self.all("equipment")[0]["values"]["quantity"], 3)
        self.delete("equipment", changed)
        self.assertEqual(self.all("equipment"), [])

    def test_required_unique_integer_and_unknown_fields_reject_without_saved_rows(self):
        self.custom_table()
        for values in ({"quantity": 1}, {"name": ""}, {"name": "Negative", "quantity": -1},
                       {"name": "Fraction", "quantity": "1.5"},
                       {"name": "Boolean quantity", "quantity": True},
                       {"name": "Unknown", "not_a_field": "data"}):
            with self.subTest(values=values), self.assertRaises(LogisticsError):
                self.create("equipment", values)
        self.assertEqual(self.all("equipment"), [])
        first = self.create("equipment", {"name": "Scanner", "quantity": 1})
        with self.assertRaises(LogisticsError):
            self.create("equipment", {"name": "Scanner", "quantity": 2})
        self.assertEqual(self.all("equipment"), [first])

    def test_reference_rejects_unknown_id_and_delete_of_referenced_target(self):
        self.custom_table()
        with self.assertRaises(LogisticsError):
            self.create("equipment", {"name": "Missing supplier", "supplier": 999999})
        self.assertEqual(self.all("equipment"), [])
        supplier = self.create("suppliers", {"name": "Supplier A"})
        equipment = self.create("equipment", {"name": "Scanner", "supplier": supplier["id"]})
        with self.assertRaises(LogisticsError):
            self.delete("suppliers", supplier)
        self.assertEqual(self.all("suppliers")[0]["id"], supplier["id"])
        self.delete("equipment", equipment)
        self.delete("suppliers", supplier)
        self.assertEqual(self.all("suppliers"), [])

    def test_reference_rejects_record_from_wrong_registered_table(self):
        self.custom_table()
        customer = self.create("customers", {"name": "A customer, not a supplier"})
        with self.assertRaises(LogisticsError):
            self.create("equipment", {"name": "Scanner", "supplier": customer["id"]})
        self.assertEqual(self.all("equipment"), [])

    def test_foreign_key_is_enforced_by_postgresql_without_crud_validation(self):
        self.custom_table()
        supplier = self.create("suppliers", {"name": "Supplier A"})
        self.create("equipment", {"name": "Scanner", "supplier": supplier["id"]})
        constraint = self.conn.execute("""SELECT count(*) AS n FROM pg_constraint
            WHERE conrelid='logistics.record_equipment'::regclass
            AND confrelid='logistics.record_suppliers'::regclass AND contype='f'""").fetchone()
        self.assertGreater(constraint["n"], 0)
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            self.conn.execute("INSERT INTO logistics.record_equipment(name,supplier) VALUES(%s,%s)",
                              ("Direct SQL orphan", 999999))
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            self.conn.execute("DELETE FROM logistics.record_suppliers WHERE id=%s", (supplier["id"],))
        self.assertEqual(len(self.all("equipment")), 1)
        self.assertEqual(len(self.all("suppliers")), 1)

    def test_purchasing_foreign_keys_reject_existing_binding_of_wrong_entity_kind(self):
        supplier = self.create("suppliers", {"name": "Supplier A"})
        item = self.create("items", {"name": "Train", "sku": "TRAIN"})
        supplier_id = supplier["system"]["core_binding_id"]
        item_id = item["system"]["core_binding_id"]
        # Both IDs exist, so an ordinary FK on core_bindings(id) is insufficient.
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            self.conn.execute("INSERT INTO logistics.purchase_orders(supplier_id,currency) VALUES(%s,'USD')", (item_id,))
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            self.conn.execute("""INSERT INTO logistics.quote_versions
                (quote_ref,version,supplier_id,item_id,quantity_priced,capacity_quantity,
                 price_minor,pricing_kind,currency,source,expires_at,expected_date)
                VALUES('wrong-item',1,%s,%s,1,1,100,'unit','USD','supplier',now()+interval '1 day',current_date)""",
                (supplier_id, supplier_id))
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            self.conn.execute("""INSERT INTO logistics.demand_lines
                (external_key,order_ref,item_id,quantity,currency)
                VALUES('wrong-item','customer-order',%s,1,'USD')""", (supplier_id,))
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM purchase_orders").fetchone()["n"], 0)
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM quote_versions").fetchone()["n"], 0)
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM demand_lines").fetchone()["n"], 0)

    def test_typed_date_boolean_and_money_fields_preserve_exact_values(self):
        self.custom_table(slug="service_jobs", fields=[
            {"slug": "due", "label": "Due date", "type": "date", "required": True},
            {"slug": "done", "label": "Done", "type": "boolean"},
            {"slug": "charge_minor", "label": "Charge", "type": "money", "min_value": 0},
        ])
        for values in (
            {"due": "not a date"}, {"due": "2026-02-30"},
            {"due": "2026-11-01", "done": "yes"},
            {"due": "2026-11-01", "charge_minor": -1},
            {"due": "2026-11-01", "charge_minor": True},
        ):
            with self.subTest(values=values), self.assertRaises(LogisticsError):
                self.create("service_jobs", values)
        valid = self.create("service_jobs", {"due": "2026-11-01", "done": False, "charge_minor": 1250})
        self.assertEqual(valid["values"]["due"], "2026-11-01")
        self.assertIs(valid["values"]["done"], False)
        self.assertEqual(valid["values"]["charge_minor"], 1250)

    def test_archived_target_preserves_old_reference_and_rejects_new_links(self):
        self.custom_table()
        supplier = self.create("suppliers", {"name": "Retired supplier"})
        existing = self.create("equipment", {"name": "Existing scanner", "supplier": supplier["id"]})
        self.archive("suppliers", supplier)
        self.assertEqual(self.all("suppliers"), [])
        self.assertTrue(self.all("suppliers", include_archived=True)[0]["archived"])
        self.assertEqual(self.all("equipment"), [existing])
        with self.assertRaises(LogisticsError):
            self.create("equipment", {"name": "New scanner", "supplier": supplier["id"]})
        self.assertEqual(self.all("equipment"), [existing])

    def test_table_and_field_identifiers_cannot_modify_operational_schema(self):
        original = r.catalog(self.conn)
        for slug in ("equipment; DROP TABLE logistics.purchase_orders;--", "../equipment", "pg_catalog.users", ""):
            with self.subTest(slug=slug), self.assertRaises(LogisticsError):
                self.custom_table(slug=slug)
        with self.assertRaises(LogisticsError):
            self.custom_table(fields=[{"slug": "name); DROP SCHEMA logistics CASCADE;--",
                                        "label": "Unsafe", "type": "text"}])
        self.assertEqual(r.catalog(self.conn), original)
        self.assertIsNotNone(self.conn.execute("SELECT to_regclass('logistics.purchase_orders') AS relation").fetchone()["relation"])

    def test_reserved_operational_tables_are_not_exposed_as_generic_crud(self):
        for table in ("stock_movements", "command_requests", "core_bindings", "schema_migrations"):
            with self.subTest(table=table):
                with self.assertRaises(LogisticsError):
                    r.list_records(self.conn, table_slug=table)
                with self.assertRaises(LogisticsError):
                    self.create(table, {"name": "Unexpected direct access"})
                with self.assertRaises(LogisticsError):
                    self.custom_table(slug=table)
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM stock_movements").fetchone()["n"], 0)

    def test_employee_fields_do_not_grant_purchase_approval_permissions(self):
        employee = self.create("employees", {"name": "Shop assistant"})
        with self.assertRaises(LogisticsError):
            self.update("employees", employee,
                        {"name": "Shop assistant", "can_approve_purchases": True})
        table = next(table for table in r.catalog(self.conn)["tables"] if table["slug"] == "employees")
        r.add_field(self.conn, table_slug="employees",
                    field={"slug": "can_approve_purchases", "label": "Can approve purchases", "type": "boolean"},
                    expected_version=table["version"], idempotency_key=self.key("field"))
        self.update("employees", employee,
                    {"name": "Shop assistant", "can_approve_purchases": True})
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM core_bindings WHERE kind='actor'").fetchone()["n"], 0)

    def test_supplier_crud_updates_current_terms_but_preserves_approved_purchase_snapshot(self):
        supplier = self.create("suppliers", {"name": "Supplier A", "address": "Old address"})
        item = self.create("items", {"name": "Train", "sku": "TRAIN"})
        supplier_binding = supplier["system"]["core_binding_id"]
        item_binding = item["system"]["core_binding_id"]
        actor = self.bind("actor", "owner", {"can_approve_purchases": True})
        demand = self.demand(item_binding, 2)
        quote = p.create_quote(
            self.conn, supplier_id=supplier_binding, item_id=item_binding,
            quantity_priced=2, capacity_quantity=2, price_minor=100, pricing_kind="unit",
            currency="USD", expires_at=datetime.now(timezone.utc) + timedelta(days=2),
            expected_date=date.today(), idempotency_key=self.key("quote"))
        po = p.create_purchase_order(self.conn, supplier_id=supplier_binding,
                                     currency="USD", idempotency_key=self.key("po"))
        line = p.add_purchase_line(self.conn, purchase_order_id=po["id"],
                                   quote_version_id=quote["id"], quantity=2,
                                   idempotency_key=self.key("po-line"))
        p.allocate_purchase_line(self.conn, po_line_id=line["id"], demand_line_id=demand,
                                  quantity=2, idempotency_key=self.key("allocate"))
        approved = p.approve_purchase_order(self.conn, purchase_order_id=po["id"],
                                            actor_id=actor, idempotency_key=self.key("approve"))
        self.assertEqual(approved["approved_supplier_snapshot"]["address"], "Old address")
        changed = self.update("suppliers", supplier, {"name": "Supplier A", "address": "New address"})
        self.assertNotEqual(changed["system"]["core_binding_id"], supplier_binding)
        after = p.get_purchase_order(self.conn, purchase_order_id=po["id"])
        self.assertEqual(after["approved_supplier_snapshot"], approved["approved_supplier_snapshot"])
        self.assertEqual(after["lines"][0]["approved_terms"], approved["lines"][0]["approved_terms"])

    def test_reference_display_keeps_supplier_history_and_marks_archived_local_records(self):
        supplier = self.create("suppliers", {"name": "Supplier A", "address": "Original address"})
        item = self.create("items", {"name": "Original train name", "sku": "TRAIN"})
        old_supplier_binding = supplier["system"]["core_binding_id"]
        new_supplier = self.update("suppliers", supplier, {"name": "Supplier A", "address": "Current address"})
        self.update("items", item, {"name": "Renamed train", "sku": "TRAIN"})
        bindings = self.conn.execute("SELECT * FROM core_bindings ORDER BY id").fetchall()
        decorated = {row["id"]: row for row in r.decorate_references(self.conn, bindings)}
        self.assertEqual(decorated[old_supplier_binding]["snapshot"]["address"], "Original address")
        self.assertEqual(decorated[new_supplier["system"]["core_binding_id"]]["snapshot"]["address"], "Current address")
        self.assertEqual(decorated[item["system"]["core_binding_id"]]["snapshot"]["name"], "Renamed train")
        self.assertFalse(decorated[new_supplier["system"]["core_binding_id"]]["local_archived"])
        self.archive("suppliers", new_supplier)
        archived = {row["id"]: row for row in r.decorate_references(self.conn, bindings)}
        self.assertTrue(archived[old_supplier_binding]["local_archived"])
        self.assertTrue(archived[new_supplier["system"]["core_binding_id"]]["local_archived"])
        self.assertEqual(archived[old_supplier_binding]["snapshot"]["address"], "Original address")

    def test_add_field_keeps_records_and_uses_schema_version_checks(self):
        self.custom_table()
        first = self.create("equipment", {"name": "Scanner", "quantity": 1})
        before = next(table for table in r.catalog(self.conn)["tables"] if table["slug"] == "equipment")
        r.add_field(self.conn, table_slug="equipment",
                    field={"slug": "serial_number", "label": "Serial number", "type": "text", "unique": True},
                    expected_version=before["version"], idempotency_key=self.key("field"))
        self.assertEqual(self.all("equipment")[0]["values"]["name"], "Scanner")
        changed = self.update("equipment", first, {"name": "Scanner", "quantity": 1, "serial_number": "SN001"})
        self.assertEqual(changed["values"]["serial_number"], "SN001")
        with self.assertRaises(LogisticsError):
            r.add_field(self.conn, table_slug="equipment",
                        field={"slug": "notes", "label": "Notes", "type": "text"},
                        expected_version=before["version"], idempotency_key=self.key("field"))
        self.assertNotIn("notes", {field["slug"] for table in r.catalog(self.conn)["tables"]
                                   if table["slug"] == "equipment" for field in table["fields"]})

    def test_record_replay_changed_payload_and_stale_version_protect_one_row(self):
        self.custom_table()
        values = {"name": "Scanner", "quantity": 1}
        first = self.create("equipment", values, idempotency_key="one-scanner")
        self.assertEqual(self.create("equipment", values, idempotency_key="one-scanner"), first)
        with self.assertRaises(IdempotencyConflict):
            self.create("equipment", {"name": "Different scanner"}, idempotency_key="one-scanner")
        changed = self.update("equipment", first, {"name": "Scanner", "quantity": 2})
        with self.assertRaises(LogisticsError):
            self.update("equipment", first, {"name": "Lost update", "quantity": 3})
        self.assertEqual(self.all("equipment"), [changed])
        with self.assertRaises(IdempotencyConflict):
            self.archive("equipment", changed, idempotency_key="one-scanner")
        self.assertEqual(self.all("equipment"), [changed])

    def test_order_submit_publishes_each_line_once_and_freezes_order_and_lines(self):
        order, lines, items = self.draft_order(two_items=True)
        current = next(row for row in self.all("customer_orders") if row["id"] == order["id"])
        options = dict(record_id=order["id"], expected_version=current["version"], idempotency_key="submit-order")
        submitted = r.submit_customer_order(self.conn, **options)
        self.assertEqual(r.submit_customer_order(self.conn, **options), submitted)
        self.assertEqual(next(row for row in self.all("customer_orders") if row["id"] == order["id"])["system"]["status"], "submitted")
        demands = self.conn.execute("SELECT * FROM demand_lines ORDER BY id").fetchall()
        self.assertEqual(len(demands), 2)
        self.assertEqual([row["quantity"] for row in demands], [3, 2])
        persisted = self.all("customer_order_lines")
        self.assertEqual({row["system"]["demand_line_id"] for row in persisted}, {row["id"] for row in demands})
        lines = persisted
        order = next(row for row in self.all("customer_orders") if row["id"] == order["id"])
        changed_line = dict(lines[0]["values"], quantity=4)
        for mutate in (
            lambda: self.update("customer_order_lines", lines[0], changed_line),
            lambda: self.update("customer_order_lines", lines[0], dict(lines[0]["values"], item_id=items[1]["id"])),
            lambda: self.update("customer_order_lines", lines[0], dict(lines[0]["values"], order_id=999999)),
            lambda: self.delete("customer_order_lines", lines[0]),
            lambda: self.create("customer_order_lines", dict(lines[0]["values"])),
            lambda: self.update("customer_orders", order, dict(order["values"], currency="EUR")),
            lambda: self.delete("customer_orders", order),
        ):
            with self.assertRaises(LogisticsError):
                mutate()
        self.assertEqual(self.conn.execute("SELECT * FROM demand_lines ORDER BY id").fetchall(), demands)
        self.assertEqual(self.all("customer_order_lines"), persisted)
        with self.assertRaises(psycopg.Error):
            self.conn.execute("UPDATE logistics.record_customer_order_lines SET quantity=99 WHERE id=%s", (lines[0]["id"],))
        self.assertEqual(self.conn.execute("SELECT * FROM demand_lines ORDER BY id").fetchall(), demands)

    def test_empty_order_cannot_publish_and_failed_request_leaves_no_saved_result(self):
        customer = self.create("customers", {"name": "Customer"})
        order = self.create("customer_orders", {
            "order_number": "EMPTY", "customer_id": customer["id"],
            "order_date": date.today().isoformat(), "currency": "USD"})
        with self.assertRaises(LogisticsError):
            r.submit_customer_order(self.conn, record_id=order["id"],
                                    expected_version=order["version"], idempotency_key="empty-submit")
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM demand_lines").fetchone()["n"], 0)
        self.assertIsNone(self.conn.execute("SELECT result FROM command_requests WHERE idempotency_key='empty-submit'").fetchone())
        self.assertEqual(self.all("customer_orders"), [order])

    def test_multiline_order_submission_failure_rolls_back_every_demand_and_line_link(self):
        order, lines, items = self.draft_order(two_items=True)
        self.archive("items", items[1])
        before = self.all("customer_order_lines")
        with self.assertRaises(LogisticsError):
            r.submit_customer_order(self.conn, record_id=order["id"],
                                    expected_version=order["version"], idempotency_key="failed-multiline-submit")
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM demand_lines").fetchone()["n"], 0)
        self.assertEqual(self.all("customer_order_lines"), before)
        self.assertEqual(self.all("customer_orders"), [order])
        self.assertIsNone(self.conn.execute("SELECT result FROM command_requests WHERE idempotency_key='failed-multiline-submit'").fetchone())
