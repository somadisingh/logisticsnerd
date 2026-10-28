"""Real HTTP-to-PostgreSQL purchasing/receiving acceptance tests."""
from datetime import date, datetime, timedelta, timezone

from fastapi.testclient import TestClient

from logistics_persistence.api import Settings, create_app
from .common import PostgresCase


class ApiPostgresTests(PostgresCase):
    def setUp(self):
        super().setUp()
        self.item = self.bind('item', 'chair', {'name': 'Chair'})
        self.supplier = self.bind('supplier', 'supplier-a', {'name': 'Supplier A', 'address': 'Original address'})
        self.location = self.bind('location', 'warehouse', {'name': 'Main warehouse'})
        self.bind('actor', 'owner', {'name': 'Owner', 'can_approve_purchases': True})
        self.demand_a = self.demand(self.item, 6, 'customer-order-a')
        self.demand_b = self.demand(self.item, 4, 'customer-order-b')
        self.client = TestClient(create_app(Settings(self.dsn, 'test-business', 'owner-token', 'owner')), raise_server_exceptions=False)
        self.auth = {'Authorization': 'Bearer owner-token'}

    def post(self, path, body, status=201):
        response = self.client.post('/api/purchasing'+path, headers=self.auth, json=body)
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def get(self, path):
        response = self.client.get('/api/purchasing'+path, headers=self.auth)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def approved_purchase(self):
        now = datetime.now(timezone.utc)
        quote = self.post('/quotes', dict(supplier_id=self.supplier, item_id=self.item,
            quantity_priced=10, capacity_quantity=10, price_minor=100, pricing_kind='unit', currency='USD',
            expires_at=(now+timedelta(days=7)).isoformat(), expected_date=(date.today()+timedelta(days=3)).isoformat(),
            idempotency_key='api-quote'))
        po = self.post('/orders', dict(supplier_id=self.supplier, currency='USD', idempotency_key='api-po'))
        line = self.post(f'/orders/{po["id"]}/lines', dict(quote_version_id=quote['id'], quantity=10,
            expected_version=po['version'], idempotency_key='api-line'))
        po = self.get(f'/orders/{po["id"]}')
        a = self.post(f'/lines/{line["id"]}/allocations', dict(demand_line_id=self.demand_a, quantity=6,
            expected_version=po['version'], idempotency_key='api-allocation-a'))
        po = self.get(f'/orders/{po["id"]}')
        b = self.post(f'/lines/{line["id"]}/allocations', dict(demand_line_id=self.demand_b, quantity=4,
            expected_version=po['version'], idempotency_key='api-allocation-b'))
        po = self.get(f'/orders/{po["id"]}')
        self.post(f'/orders/{po["id"]}/approve', dict(expected_version=po['version'], idempotency_key='api-approve'), 200)
        return po['id'], line['id'], a['id'], b['id']

    def delivery(self, line, a, b):
        return dict(delivery_ref='supplier-document-7', received_on=date.today().isoformat(),
            idempotency_key='api-delivery', lines=[dict(po_line_id=line, item_id=self.item,
                location_id=self.location, quantity=10, allocations=[
                    dict(purchase_allocation_id=a,demand_line_id=self.demand_a,quantity=6),
                    dict(purchase_allocation_id=b,demand_line_id=self.demand_b,quantity=4)])])

    def test_http_workflow_survives_connections_and_receives_several_customer_lines(self):
        po, line, a, b = self.approved_purchase()
        self.assertEqual(self.conn.execute('SELECT count(*) AS n FROM logistics.stock_movements').fetchone()['n'], 0)
        before = self.get('/workspace')
        first = next(d for d in before['demands'] if d['id'] == self.demand_a)
        self.assertEqual((first['quantity'],first['reserved_quantity'],first['inbound_quantity'],first['remaining_to_buy']),(6,0,6,0))
        body = self.delivery(line, a, b)
        receipt = self.post('/deliveries', body)
        self.assertEqual(len(receipt['lines'][0]['reservations']), 2)
        self.assertEqual(self.post('/deliveries', body), receipt)
        changed = dict(body, lines=[dict(body['lines'][0],quantity=11)])
        self.post('/deliveries',changed,409)
        self.post('/deliveries',dict(body,idempotency_key='fresh-key-same-physical-delivery'),422)
        progress = self.get(f'/orders/{po}/progress')
        self.assertEqual(progress['lines'][0]['received_quantity'],10)
        self.assertEqual(progress['lines'][0]['outstanding_quantity'],0)
        self.assertEqual([r['received_quantity'] for r in progress['lines'][0]['allocations']],[6,4])
        levels = self.get(f'/stock/{self.item}/{self.location}')
        self.assertEqual((levels['on_hand'],levels['reserved'],levels['available']),(10,10,0))
        workspace = self.get('/workspace')
        self.assertEqual(len(workspace['purchase_orders']),1)
        self.assertEqual(workspace['stock'][0]['available'],0)
        first = next(d for d in workspace['demands'] if d['id'] == self.demand_a)
        self.assertEqual((first['reserved_quantity'],first['inbound_quantity'],first['remaining_to_buy']),(6,0,0))
        self.assertEqual(self.conn.execute('SELECT count(*) AS n FROM logistics.receipts').fetchone()['n'],1)
        self.assertEqual(self.conn.execute('SELECT count(*) AS n FROM logistics.stock_movements').fetchone()['n'],1)

    def test_invalid_allocation_rolls_back_complete_delivery_through_api(self):
        _, line, a, b = self.approved_purchase()
        body=self.delivery(line,a,b)
        body['lines'].append(dict(po_line_id=line,item_id=self.item,location_id=self.location,
            quantity=1,allocations=[]))
        self.post('/deliveries',body,422)
        self.assertEqual(self.conn.execute('SELECT count(*) AS n FROM logistics.receipts').fetchone()['n'],0)
        self.assertEqual(self.conn.execute('SELECT count(*) AS n FROM logistics.stock_movements').fetchone()['n'],0)
        self.assertEqual(self.conn.execute('SELECT count(*) AS n FROM logistics.stock_reservations').fetchone()['n'],0)
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM logistics.command_requests WHERE idempotency_key='api-delivery'").fetchone()['n'],0)
        # Failed transactions do not consume the key. Correct content can retry.
        body['lines'].pop()
        self.post('/deliveries',body)

    def test_api_checks_business_identity_before_workspace_or_replay_reads(self):
        wrong=TestClient(create_app(Settings(self.dsn,'another-business','owner-token','owner')),raise_server_exceptions=False)
        response=wrong.get('/api/purchasing/workspace',headers=self.auth)
        self.assertEqual(response.status_code,403,response.text)
        self.assertNotIn(self.dsn,response.text)
