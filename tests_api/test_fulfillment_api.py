"""Shipping transport authority, input validation and existing-command wiring."""
from contextlib import contextmanager
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from logistics_persistence.api import Settings, create_app
from logistics_persistence.errors import Conflict, NotFound


class FulfillmentApiTests(unittest.TestCase):
    def setUp(self):
        self.opened = []

        @contextmanager
        def connection(settings):
            self.opened.append(settings)
            yield object()

        self.settings = Settings('private-dsn', 'business-one', 'owner-token', 'owner')
        self.client = TestClient(create_app(self.settings, connection_factory=connection),
                                 raise_server_exceptions=False)
        self.auth = {'Authorization': 'Bearer owner-token'}

    def test_all_shipping_reads_and_commands_require_auth_before_database_access(self):
        for path in ('/workspace', '/shipments', '/shipments/1'):
            self.assertEqual(self.client.get('/api/fulfillment'+path).status_code, 401)
        for path, body in (
            ('/shipments', {'shipment_number': 'S1', 'order_ref': 'order'}),
            ('/shipments/1/lines', {'reservation_id': 2, 'quantity': 3}),
            ('/shipments/1/dispatch', {'carrier': 'Manual', 'as_of': '2026-10-30', 'tracking_ref': 'T1'}),
            ('/shipments/1/events', {'event': 'delivered', 'occurred_at': '2026-10-30T12:00:00Z'})):
            response = self.client.post('/api/fulfillment'+path, json={**body, 'idempotency_key': 'request'})
            self.assertEqual(response.status_code, 401)
        self.assertEqual(self.opened, [])

    def test_reads_use_server_business_and_do_not_accept_arbitrary_database_routing(self):
        with patch('logistics_persistence.fulfillment.workspace', return_value={'orders': []}) as read:
            response = self.client.get('/api/fulfillment/workspace?business_key=other&database_url=other', headers=self.auth)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(self.opened, [self.settings])
            self.assertEqual(read.call_count, 1)

    def test_mutations_reject_authority_fields(self):
        for extra in ({'business_key': 'other'}, {'database_url': 'do-not-echo'}, {'actor_id': 9}):
            response = self.client.post('/api/fulfillment/shipments', headers=self.auth,
                json={'shipment_number': 'S1', 'order_ref': 'customer-order', 'idempotency_key': 'new', **extra})
            self.assertEqual(response.status_code, 422)
            self.assertNotIn('do-not-echo', response.text)

    def test_positive_ids_quantities_and_paths_are_strict(self):
        with patch('logistics_persistence.fulfillment.add_shipment_line') as command:
            for bad in (True, 0, -1, 1.5, '2'):
                for field in ('reservation_id', 'quantity'):
                    body = {'reservation_id': 2, 'quantity': 1, 'idempotency_key': 'line', field: bad}
                    response = self.client.post('/api/fulfillment/shipments/1/lines', headers=self.auth, json=body)
                    self.assertEqual(response.status_code, 422, response.text)
            for path in ('0', '-1', 'not-a-number'):
                self.assertEqual(self.client.get('/api/fulfillment/shipments/'+path, headers=self.auth).status_code, 422)
            command.assert_not_called()

    def test_draft_and_line_delegation_preserve_request_identity(self):
        with patch('logistics_persistence.fulfillment.create_shipment', return_value={'shipment_id': 3}) as draft:
            response = self.client.post('/api/fulfillment/shipments', headers=self.auth,
                json={'shipment_number': 'S1', 'order_ref': 'customer-order', 'idempotency_key': 'draft-key'})
            self.assertEqual(response.status_code, 201, response.text)
            self.assertEqual(draft.call_args.kwargs, {'shipment_number': 'S1', 'order_ref': 'customer-order', 'idempotency_key': 'draft-key'})
        with patch('logistics_persistence.fulfillment.add_shipment_line', return_value={'line_id': 7}) as line:
            response = self.client.post('/api/fulfillment/shipments/3/lines', headers=self.auth,
                json={'reservation_id': 2, 'quantity': 3, 'idempotency_key': 'line-key'})
            self.assertEqual(response.status_code, 201, response.text)
            self.assertEqual(line.call_args.kwargs, {'shipment_id': 3, 'reservation_id': 2, 'quantity': 3, 'idempotency_key': 'line-key'})

    def test_dispatch_requires_date_carrier_and_label_or_tracking(self):
        valid = {'carrier': 'Manual carrier', 'as_of': '2026-10-30', 'tracking_ref': 'T1', 'idempotency_key': 'dispatch'}
        with patch('logistics_persistence.fulfillment.dispatch', return_value={'status': 'dispatched'}) as command:
            for change in ({'carrier': ''}, {'as_of': 'not-a-date'}, {'tracking_ref': None}, {'tracking_ref': ''}):
                response = self.client.post('/api/fulfillment/shipments/3/dispatch', headers=self.auth, json={**valid, **change})
                self.assertEqual(response.status_code, 422, response.text)
            command.assert_not_called()
            response = self.client.post('/api/fulfillment/shipments/3/dispatch', headers=self.auth, json=valid)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(command.call_args.kwargs, {'shipment_id': 3, 'carrier': 'Manual carrier', 'as_of': '2026-10-30',
                'tracking_ref': 'T1', 'label_ref': None, 'idempotency_key': 'dispatch'})

    def test_events_require_timezone_and_known_event_without_accepting_status_overwrite(self):
        valid = {'event': 'delivered', 'occurred_at': '2026-10-30T12:30:00Z', 'idempotency_key': 'event'}
        with patch('logistics_persistence.fulfillment.record_tracking_event', return_value={'status': 'delivered'}) as command:
            for change in ({'event': 'draft'}, {'occurred_at': '2026-10-30T12:30:00'}, {'status': 'delivered'}):
                response = self.client.post('/api/fulfillment/shipments/3/events', headers=self.auth, json={**valid, **change})
                self.assertEqual(response.status_code, 422, response.text)
            command.assert_not_called()
            response = self.client.post('/api/fulfillment/shipments/3/events', headers=self.auth, json=valid)
            self.assertEqual(response.status_code, 201, response.text)
            self.assertEqual(command.call_args.kwargs, {'shipment_id': 3, 'event': 'delivered',
                'occurred_at': '2026-10-30T12:30:00+00:00', 'detail': None, 'idempotency_key': 'event'})

    def test_not_found_conflicts_and_unexpected_errors_are_safe(self):
        for error, expected in ((NotFound('Shipment not found'), 404), (Conflict('Shipment already dispatched'), 409),
                (RuntimeError('password=private-host SELECT hidden_ledger'), 503)):
            with patch('logistics_persistence.fulfillment.shipment', side_effect=error):
                response = self.client.get('/api/fulfillment/shipments/3', headers=self.auth)
                self.assertEqual(response.status_code, expected, response.text)
                self.assertNotIn('private-host', response.text)
                self.assertNotIn('hidden_ledger', response.text)

    def test_unconfigured_service_does_not_open_database(self):
        client = TestClient(create_app(Settings()))
        self.assertEqual(client.get('/api/fulfillment/workspace', headers=self.auth).status_code, 503)
