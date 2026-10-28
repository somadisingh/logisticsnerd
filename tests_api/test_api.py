"""HTTP-boundary tests: authority, validation, wiring and error sanitization.

Business invariants belong to real PostgreSQL tests, not this fake adapter.
"""
from contextlib import contextmanager
from datetime import date
import unittest

from fastapi.testclient import TestClient

from logistics_persistence.api import Settings, WorkspaceService, create_app


class FakeService(WorkspaceService):
    def __init__(self):
        self.calls = []
        self.actor_refs = []
        self.failure = None

    def workspace(self, conn):
        return {"references": [], "demands": [], "quotes": [], "purchase_orders": [],
                "purchase_lines": [], "allocations": [], "stock": []}

    def actor_id(self, conn, actor_ref):
        self.actor_refs.append(actor_ref)
        return 71

    def call(self, conn, operation, payload):
        self.calls.append((operation, payload))
        if self.failure:
            raise self.failure
        return {"operation": operation, "saved": True}


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.settings = Settings("postgresql://private-password@private-host/db", "business-one", "local-secret-token", "owner-external-ref")
        self.opened = []
        self.service = FakeService()

        @contextmanager
        def connect(settings):
            self.opened.append(settings)
            yield object()

        self.client = TestClient(create_app(self.settings, connection_factory=connect, service=self.service), raise_server_exceptions=False)
        self.auth = {"Authorization": "Bearer local-secret-token"}

    def test_health_is_public_and_does_not_disclose_configuration(self):
        response = self.client.get("/api/purchasing/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["configured"])
        self.assertNotIn("private", response.text)
        self.assertNotIn("business-one", response.text)
        self.assertNotIn("local-secret-token", response.text)
        self.assertEqual(self.opened, [])

    def test_reads_and_commands_require_bearer_before_database_access(self):
        for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "local-secret-token"}):
            response = self.client.get("/api/purchasing/workspace", headers=headers)
            self.assertEqual(response.status_code, 401)
        response = self.client.post("/api/purchasing/orders", json={"supplier_id": 4, "currency": "USD", "idempotency_key": "new-draft"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.opened, [])
        self.assertEqual(self.service.calls, [])

    def test_database_and_business_are_resolved_only_from_server_settings(self):
        response = self.client.get("/api/purchasing/workspace?database_url=evil&business_key=other", headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.opened, [self.settings])

    def test_approval_actor_comes_from_configured_binding(self):
        response = self.client.post("/api/purchasing/orders/12/approve", headers=self.auth,
            json={"idempotency_key": "approve-12", "expected_version": 3})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.service.actor_refs, ["owner-external-ref"])
        self.assertEqual(self.service.calls, [("approve_purchase_order", {
            "purchase_order_id": 12, "actor_id": 71, "idempotency_key": "approve-12", "expected_version": 3})])

    def test_payload_cannot_override_actor_business_or_database(self):
        for extra in ({"actor_id": 999}, {"business_key": "other"}, {"database_url": "secret-should-not-echo"}):
            response = self.client.post("/api/purchasing/orders/12/approve", headers=self.auth,
                json={"idempotency_key": "approve-12", **extra})
            self.assertEqual(response.status_code, 422)
            self.assertNotIn("secret-should-not-echo", response.text)
        self.assertEqual(self.service.calls, [])

    def test_typed_ids_and_quantities_reject_boolean_fraction_and_zero(self):
        for quantity in (True, 1.5, 0, -1, "3"):
            response = self.client.post("/api/purchasing/orders/12/lines", headers=self.auth,
                json={"quote_version_id": 4, "quantity": quantity, "idempotency_key": "line"})
            self.assertEqual(response.status_code, 422)
        self.assertEqual(self.service.calls, [])

    def test_whole_delivery_is_one_service_command_with_all_portions(self):
        response = self.client.post("/api/purchasing/deliveries", headers=self.auth, json={
            "delivery_ref": "supplier-doc-123", "received_on": "2026-10-27", "idempotency_key": "delivery-once",
            "lines": [
                {"po_line_id": 5, "item_id": 2, "location_id": 3, "quantity": 10,
                 "allocations": [{"purchase_allocation_id": 8, "demand_line_id": 11, "quantity": 6},
                                 {"purchase_allocation_id": 9, "demand_line_id": 12, "quantity": 4}]},
                {"po_line_id": 6, "item_id": 4, "location_id": 3, "quantity": 2, "allocations": []},
            ]})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(len(self.service.calls), 1)
        operation, payload = self.service.calls[0]
        self.assertEqual(operation, "receive_delivery")
        self.assertEqual(payload["received_on"], date(2026, 10, 27))
        self.assertEqual(len(payload["lines"]), 2)
        self.assertEqual(len(payload["lines"][0]["allocations"]), 2)
        self.assertEqual(payload["idempotency_key"], "delivery-once")

    def test_unexpected_failure_does_not_echo_connection_or_sql(self):
        self.service.failure = RuntimeError("postgresql://password@private-host; SELECT private_secret")
        strict_client = TestClient(self.client.app, raise_server_exceptions=True)
        response = strict_client.get("/api/purchasing/orders/12/progress", headers=self.auth)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("password", response.text)
        self.assertNotIn("private-host", response.text)
        self.assertNotIn("SELECT", response.text)

    def test_no_browser_cors_grant(self):
        response = self.client.options("/api/purchasing/orders", headers={
            "Origin": "https://untrusted.example", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type"})
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_unconfigured_backend_does_not_attempt_database_connection(self):
        client = TestClient(create_app(Settings(), service=self.service))
        response = client.get("/api/purchasing/workspace", headers=self.auth)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(client.get("/api/purchasing/health").json()["configured"], False)


if __name__ == "__main__":
    unittest.main()
