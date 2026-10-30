"""Real HTTP-to-PostgreSQL cash acceptance: receipt charge, opening cash, payment."""
from datetime import date, datetime, timedelta, timezone

from fastapi.testclient import TestClient

from logistics_persistence.api import Settings, create_app
from .common import PostgresCase


class CashApiTests(PostgresCase):
    def setUp(self):
        super().setUp()
        self.item = self.bind('item', 'chair', {'name': 'Chair'})
        self.supplier = self.bind('supplier', 'chair-supplier', {'name': 'Chair supplier'})
        self.location = self.bind('location', 'warehouse', {'name': 'Warehouse'})
        self.bind('actor', 'owner', {'name': 'Owner', 'can_approve_purchases': True})
        self.demand_id = self.demand(self.item, 4, 'customer-order-a')
        self.client = TestClient(create_app(Settings(self.dsn, 'test-business', 'owner-token', 'owner')),
                                 raise_server_exceptions=False)
        self.auth = {'Authorization': 'Bearer owner-token'}

    def call(self, method, path, body=None, status=200):
        response = self.client.request(method, path, headers=self.auth, json=body)
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def receive_purchase(self):
        now = datetime.now(timezone.utc)
        quote = self.call('POST', '/api/purchasing/quotes', dict(supplier_id=self.supplier, item_id=self.item,
            quantity_priced=4, capacity_quantity=4, price_minor=125, currency='USD',
            expected_date=(date.today() + timedelta(days=1)).isoformat(),
            expires_at=(now + timedelta(days=2)).isoformat(), idempotency_key='quote'), 201)
        po = self.call('POST', '/api/purchasing/orders', dict(supplier_id=self.supplier, currency='USD',
                                                             idempotency_key='po'), 201)
        line = self.call('POST', f'/api/purchasing/orders/{po["id"]}/lines', dict(
            quote_version_id=quote['id'], quantity=4, idempotency_key='line'), 201)
        allocation = self.call('POST', f'/api/purchasing/lines/{line["id"]}/allocations', dict(
            demand_line_id=self.demand_id, quantity=4, idempotency_key='allocation'), 201)
        self.call('POST', f'/api/purchasing/orders/{po["id"]}/approve', dict(idempotency_key='approve'))
        return self.call('POST', '/api/purchasing/deliveries', dict(delivery_ref='CHAIRS-1',
            received_on=date.today().isoformat(), idempotency_key='delivery', lines=[dict(
                po_line_id=line['id'], item_id=self.item, location_id=self.location, quantity=4,
                allocations=[dict(purchase_allocation_id=allocation['id'], demand_line_id=self.demand_id,
                                  quantity=4)])]), 201)

    def test_receipt_opening_cash_and_payment_through_http(self):
        self.assertEqual(self.call('GET', '/api/cash/suppliers'), [])
        self.call('POST', '/api/cash/opening', dict(amount_minor=1000, as_of='2026-10-01',
                                                   idempotency_key='early-opening'), 422)
        receipt = self.receive_purchase()
        self.assertEqual([c['amount_minor'] for c in receipt['supplier_charges']], [500])

        opening = dict(amount_minor=10000, as_of='2026-10-01', idempotency_key='opening')
        first = self.call('POST', '/api/cash/opening', opening, 201)
        self.assertEqual(self.call('POST', '/api/cash/opening', opening, 201), first)
        self.call('POST', '/api/cash/opening', dict(opening, idempotency_key='opening-2'), 409)

        payment = dict(supplier_id=self.supplier, amount_minor=200, paid_on=date.today().isoformat(),
                       idempotency_key='payment')
        paid = self.call('POST', '/api/cash/supplier-payments', payment, 201)
        self.assertEqual(paid['owed_after_minor'], 300)
        self.assertEqual(self.call('POST', '/api/cash/supplier-payments', payment, 201), paid)
        self.call('POST', '/api/cash/supplier-payments', dict(payment, amount_minor=201), 409)
        over = self.call('POST', '/api/cash/supplier-payments', dict(payment, amount_minor=301,
                                                                     idempotency_key='too-much'), 422)
        self.assertIn('exceeds the 300 owed', over['error']['message'])

        self.assertEqual(self.call('GET', '/api/cash/suppliers'), [dict(
            supplier_id=self.supplier, supplier_key='chair-supplier', name='Chair supplier', currency='USD',
            charged_minor=500, paid_minor=200, owed_minor=300)])
        self.assertEqual(self.call('GET', '/api/cash/balance'), dict(
            currency='USD', opening_minor=10000, opened_on='2026-10-01', paid_out_minor=200, balance_minor=9800))
        self.assertEqual(self.conn.execute('SELECT count(*) AS n FROM logistics.money_ledger').fetchone()['n'], 3)
