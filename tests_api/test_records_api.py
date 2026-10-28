"""Business API authority and transport tests; database rules have PG coverage."""
from contextlib import contextmanager
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from logistics_persistence.api import Settings, create_app
from logistics_persistence.errors import Conflict, ValidationError


class RecordsApiTests(unittest.TestCase):
    def setUp(self):
        self.opened = []

        @contextmanager
        def connect(settings):
            self.opened.append(settings.business_key)
            yield object()

        self.client = TestClient(create_app(Settings("private-dsn", "one-business", "token", "owner"),
            connection_factory=connect), raise_server_exceptions=False)
        self.headers = {"Authorization": "Bearer token"}

    def test_setup_and_generic_records_require_owner_before_database_access(self):
        paths = ["/catalog", "/tables/employees/records", "/tables/stock_movements/records"]
        for path in paths:
            self.assertEqual(self.client.get("/api/business" + path).status_code, 401)
        self.assertEqual(self.client.post("/api/business/setup", json={
            "business_name": "Shop", "currency": "USD", "idempotency_key": "setup"}).status_code, 401)
        self.assertEqual(self.opened, [])

    def test_setup_cannot_choose_another_database_or_authoritative_role(self):
        for extra in ({"database_url": "hidden-value"}, {"business_key": "other"}, {"actor_id": 1}):
            response = self.client.post("/api/business/setup", headers=self.headers, json={
                "business_name": "Shop", "currency": "USD", "idempotency_key": "setup", **extra})
            self.assertEqual(response.status_code, 422, response.text)
            self.assertNotIn("hidden-value", response.text)

    def test_table_field_definitions_validate_and_cannot_accept_sql_or_roles(self):
        base = {"slug": "repairs", "label": "Repairs", "fields": [{
            "slug": "supplier_id", "label": "Supplier", "type": "reference", "target_table": "suppliers"}],
            "idempotency_key": "table"}
        for change in ({"slug": "repairs;DROP TABLE x"}, {"role": "actor"},
                       {"fields": [{"slug": "name", "label": "Name", "type": "sql"}]}):
            response = self.client.post("/api/business/tables", headers=self.headers, json={**base, **change})
            self.assertEqual(response.status_code, 422, response.text)

    def test_reference_table_and_required_flags_reach_domain_service(self):
        with patch("logistics_persistence.records.create_table", return_value={"table": {"slug": "repairs"}}) as call:
            response = self.client.post("/api/business/tables", headers=self.headers, json={
                "slug": "repairs", "label": "Repairs", "fields": [{"slug": "supplier_id", "label": "Supplier",
                    "type": "reference", "required": True, "target_table": "suppliers"}], "idempotency_key": "table"})
            self.assertEqual(response.status_code, 201, response.text)
            kwargs = call.call_args.kwargs
            self.assertEqual(kwargs["fields"][0]["target_table"], "suppliers")
            self.assertTrue(kwargs["fields"][0]["required"])
            self.assertEqual(self.opened, ["one-business"])

    def test_record_version_and_archive_are_explicit(self):
        with patch("logistics_persistence.records.archive_record", return_value={"record": {"archived": True}}) as call:
            response = self.client.post("/api/business/tables/employees/records/5/archive", headers=self.headers,
                json={"archived": True, "expected_version": 2, "idempotency_key": "archive"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(call.call_args.kwargs, {"table_slug": "employees", "record_id": 5,
                "archived": True, "expected_version": 2, "idempotency_key": "archive"})
        response = self.client.patch("/api/business/tables/employees/records/5", headers=self.headers,
            json={"values": {"name": "New"}, "idempotency_key": "edit"})
        self.assertEqual(response.status_code, 422)

    def test_submit_is_separate_from_generic_record_edits(self):
        with patch("logistics_persistence.records.submit_customer_order", return_value={"submitted": True}) as call:
            response = self.client.post("/api/business/orders/3/submit", headers=self.headers,
                json={"expected_version": 2, "idempotency_key": "submit"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(call.call_args.kwargs, {"record_id": 3, "expected_version": 2, "idempotency_key": "submit"})

    def test_domain_errors_remain_readable_and_driver_errors_are_private(self):
        for failure, status, message in ((Conflict("Record has changed; reload it"), 409, "reload"),
                (ValidationError("Supplier does not exist"), 422, "Supplier"),
                (RuntimeError("password=private-host SELECT hidden_table"), 503, "unavailable")):
            with patch("logistics_persistence.records.list_records", side_effect=failure):
                response = self.client.get("/api/business/tables/employees/records", headers=self.headers)
                self.assertEqual(response.status_code, status, response.text)
                self.assertIn(message, response.text)
                self.assertNotIn("private-host", response.text)
                self.assertNotIn("hidden_table", response.text)
