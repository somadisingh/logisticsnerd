"""Cash transport authority, input validation and command wiring."""
from contextlib import contextmanager
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from logistics_persistence.api import Settings, create_app
from logistics_persistence.errors import Conflict, ValidationError


class CashApiTests(unittest.TestCase):
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

    def test_all_cash_reads_and_commands_require_auth_before_database_access(self):
        for path in ('/suppliers', '/balance'):
            self.assertEqual(self.client.get('/api/cash'+path).status_code, 401)
        for path, body in (('/supplier-payments', {'supplier_id': 1, 'amount_minor': 100, 'paid_on': '2026-10-30'}),
                           ('/opening', {'amount_minor': 100, 'as_of': '2026-10-30'})):
            response = self.client.post('/api/cash'+path, json={**body, 'idempotency_key': 'request'})
            self.assertEqual(response.status_code, 401)
        self.assertEqual(self.opened, [])

    def test_reads_use_server_business(self):
        with patch('logistics_persistence.cash.supplier_balances', return_value=[]) as read:
            response = self.client.get('/api/cash/suppliers?business_key=other&database_url=other', headers=self.auth)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(self.opened, [self.settings])
            self.assertEqual(read.call_count, 1)
        with patch('logistics_persistence.cash.cash_balance', return_value={'balance_minor': 5}):
            self.assertEqual(self.client.get('/api/cash/balance', headers=self.auth).json(), {'balance_minor': 5})

    def test_payment_inputs_are_strict_and_delegate_request_identity(self):
        valid = {'supplier_id': 2, 'amount_minor': 300, 'paid_on': '2026-10-30', 'idempotency_key': 'pay-key'}
        with patch('logistics_persistence.cash.record_supplier_payment', return_value={'payment_id': 1}) as command:
            for change in ({'supplier_id': 0}, {'supplier_id': '2'}, {'amount_minor': 0}, {'amount_minor': -5},
                           {'amount_minor': 1.5}, {'amount_minor': True}, {'paid_on': 'not-a-date'},
                           {'currency': 'EUR'}, {'business_key': 'other'}, {'idempotency_key': ''}):
                response = self.client.post('/api/cash/supplier-payments', headers=self.auth, json={**valid, **change})
                self.assertEqual(response.status_code, 422, response.text)
            command.assert_not_called()
            response = self.client.post('/api/cash/supplier-payments', headers=self.auth, json=valid)
            self.assertEqual(response.status_code, 201, response.text)
            self.assertEqual(command.call_args.kwargs, {'supplier_id': 2, 'amount_minor': 300,
                                                        'paid_on': '2026-10-30', 'idempotency_key': 'pay-key'})

    def test_opening_inputs_are_strict_and_delegate_request_identity(self):
        valid = {'amount_minor': 0, 'as_of': '2026-10-01', 'idempotency_key': 'opening-key'}
        with patch('logistics_persistence.cash.record_opening_cash', return_value={'ledger_entry_id': 1}) as command:
            for change in ({'amount_minor': -1}, {'amount_minor': '100'}, {'as_of': ''}, {'currency': 'USD'}):
                response = self.client.post('/api/cash/opening', headers=self.auth, json={**valid, **change})
                self.assertEqual(response.status_code, 422, response.text)
            command.assert_not_called()
            response = self.client.post('/api/cash/opening', headers=self.auth, json=valid)
            self.assertEqual(response.status_code, 201, response.text)
            self.assertEqual(command.call_args.kwargs, {'amount_minor': 0, 'as_of': '2026-10-01',
                                                        'idempotency_key': 'opening-key'})

    def test_rejections_and_unexpected_errors_are_safe(self):
        body = {'supplier_id': 2, 'amount_minor': 300, 'paid_on': '2026-10-30', 'idempotency_key': 'pay'}
        for error, expected in ((ValidationError('Payment of 300 exceeds the 0 owed to this supplier'), 422),
                                (Conflict('Opening cash has already been recorded'), 409),
                                (RuntimeError('password=private-host SELECT hidden_ledger'), 503)):
            with patch('logistics_persistence.cash.record_supplier_payment', side_effect=error):
                response = self.client.post('/api/cash/supplier-payments', headers=self.auth, json=body)
                self.assertEqual(response.status_code, expected, response.text)
                self.assertNotIn('private-host', response.text)
                self.assertNotIn('hidden_ledger', response.text)

    def test_unconfigured_service_does_not_open_database(self):
        client = TestClient(create_app(Settings()))
        self.assertEqual(client.get('/api/cash/balance', headers=self.auth).status_code, 503)
