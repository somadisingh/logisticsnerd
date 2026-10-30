"""Real HTTP-to-PostgreSQL shipping acceptance around the existing stock engine."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from threading import Barrier

from fastapi.testclient import TestClient

from logistics_persistence import records, stock
from logistics_persistence.api import Settings, create_app
from .common import PostgresCase


class FulfillmentApiTests(PostgresCase):
    def setUp(self):
        super().setUp()
        self.item = self.bind('item', 'robot', {'name': 'Blue robot'})
        self.supplier = self.bind('supplier', 'toy-supplier', {'name': 'Toy supplier'})
        self.location = self.bind('location', 'warehouse', {'name': 'Toy warehouse'})
        self.bind('actor', 'owner', {'name': 'Owner', 'can_approve_purchases': True})
        self.demand_a = self.demand(self.item, 6, 'customer-order-a')
        self.demand_b = self.demand(self.item, 4, 'customer-order-b')
        self.client = TestClient(create_app(Settings(self.dsn, 'test-business', 'owner-token', 'owner')),
                                 raise_server_exceptions=False)
        self.auth = {'Authorization': 'Bearer owner-token'}

    def post(self, path, body, status=201):
        response = self.client.post('/api/fulfillment' + path, headers=self.auth, json=body)
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def get(self, path):
        response = self.client.get('/api/fulfillment' + path, headers=self.auth)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def purchase_post(self, path, body, status=201):
        response = self.client.post('/api/purchasing' + path, headers=self.auth, json=body)
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def reserve_receipt(self, demand_id=None, quantity=6, item_id=None, **kwargs):
        demand_id = demand_id or self.demand_a
        item_id = item_id or self.item
        demand = self.conn.execute('SELECT * FROM logistics.demand_lines WHERE id=%s', (demand_id,)).fetchone()
        return stock.receive_and_reserve(self.conn, item_id, quantity, self.key('source'),
            demand['external_key'], self.key('receipt'), demand_line_id=demand_id,
            location_id=self.location, received_on=date.today(), **kwargs)

    def draft(self, number='SHIP-1', order_ref='customer-order-a'):
        return self.post('/shipments', dict(shipment_number=number, order_ref=order_ref,
            idempotency_key=self.key('draft')))['shipment_id']

    def add_line(self, shipment_id, reservation_id, quantity, status=201):
        return self.post(f'/shipments/{shipment_id}/lines', dict(reservation_id=reservation_id,
            quantity=quantity, idempotency_key=self.key('line')), status)

    def dispatch_body(self, **kwargs):
        return dict(carrier='Example carrier', as_of=date.today().isoformat(), tracking_ref='TRACK-1',
                    idempotency_key=self.key('dispatch'), **kwargs)

    def movement_count(self):
        return self.conn.execute('SELECT count(*) AS n FROM logistics.stock_movements').fetchone()['n']

    def test_purchase_receipt_to_partial_shipment_changes_stock_once_through_http(self):
        now = datetime.now(timezone.utc)
        quote = self.purchase_post('/quotes', dict(supplier_id=self.supplier, item_id=self.item,
            quantity_priced=6, capacity_quantity=6, price_minor=100, currency='USD',
            expected_date=(date.today() + timedelta(days=1)).isoformat(),
            expires_at=(now + timedelta(days=2)).isoformat(), idempotency_key='quote'))
        purchase = self.purchase_post('/orders', dict(supplier_id=self.supplier,
            currency='USD', idempotency_key='purchase'))
        line = self.purchase_post(f'/orders/{purchase["id"]}/lines', dict(
            quote_version_id=quote['id'], quantity=6, idempotency_key='purchase-line'))
        allocation = self.purchase_post(f'/lines/{line["id"]}/allocations', dict(
            demand_line_id=self.demand_a, quantity=6, idempotency_key='purchase-allocation'))
        self.purchase_post(f'/orders/{purchase["id"]}/approve', dict(idempotency_key='approve'), 200)
        receipt = self.purchase_post('/deliveries', dict(delivery_ref='TOY-DELIVERY-1',
            received_on=date.today().isoformat(), idempotency_key='delivery', lines=[dict(
                po_line_id=line['id'], item_id=self.item, location_id=self.location, quantity=6,
                allocations=[dict(purchase_allocation_id=allocation['id'], demand_line_id=self.demand_a,
                                  quantity=6)])]))
        reservation = receipt['lines'][0]['reservations'][0]['reservation_id']
        shipment_id = self.draft()
        body = dict(reservation_id=reservation, quantity=4, idempotency_key='shipping-line')
        saved_line = self.post(f'/shipments/{shipment_id}/lines', body)
        self.assertEqual(self.post(f'/shipments/{shipment_id}/lines', body), saved_line)
        self.assertEqual(stock.stock_summary(self.conn, self.item, self.location)['on_hand'], 6)
        self.assertEqual(self.movement_count(), 1)
        self.assertEqual(self.get(f'/shipments/{shipment_id}')['status'], 'draft')

        dispatch = self.dispatch_body()
        dispatched = self.post(f'/shipments/{shipment_id}/dispatch', dispatch, 200)
        self.assertEqual(self.post(f'/shipments/{shipment_id}/dispatch', dispatch, 200), dispatched)
        self.post(f'/shipments/{shipment_id}/dispatch', dict(dispatch, carrier='Changed carrier'), 409)
        self.post(f'/shipments/{shipment_id}/dispatch', dict(dispatch, idempotency_key='new-dispatch'), 409)
        levels = stock.stock_summary(self.conn, self.item, self.location)
        self.assertEqual((levels['on_hand'], levels['reserved'], levels['available']), (2, 2, 0))
        self.assertEqual(self.movement_count(), 2)
        workspace = self.get('/workspace')
        remainder = next(row for row in workspace['reservations'] if row['reservation_id'] == reservation)
        self.assertEqual((remainder['remaining_quantity'], remainder['planned_quantity'],
                          remainder['available_to_plan']), (2, 0, 2))
        demand = next(row for order in workspace['orders'] for row in order['lines']
                      if row['demand_line_id'] == self.demand_a)
        self.assertEqual(demand['shipped'], 4)
        detail = self.get(f'/shipments/{shipment_id}')
        self.assertEqual(detail['lines'][0]['location_id'], self.location)
        self.assertEqual(detail['lines'][0]['demand_line_id'], self.demand_a)
        self.assertEqual(detail['lines'][0]['movements'][0]['quantity'], 4)

    def test_workspace_subtracts_every_draft_and_mixed_orders_cannot_share_shipment(self):
        first = self.reserve_receipt()
        second = self.reserve_receipt(self.demand_b, 4)
        a = self.draft('SHIP-A')
        b = self.draft('SHIP-B')
        self.add_line(a, first['reservation_id'], 4)
        self.add_line(b, first['reservation_id'], 3, 409)
        self.add_line(b, first['reservation_id'], 2)
        self.add_line(a, second['reservation_id'], 1, 422)
        workspace = self.get('/workspace')
        reserved = next(row for row in workspace['reservations']
                        if row['reservation_id'] == first['reservation_id'])
        self.assertEqual((reserved['remaining_quantity'], reserved['planned_quantity'],
                          reserved['available_to_plan']), (6, 6, 0))
        summary = {row['shipment_id']: row for row in workspace['shipments']}
        self.assertEqual((summary[a]['line_count'], summary[a]['total_quantity']), (1, 4))
        self.assertEqual((summary[b]['line_count'], summary[b]['total_quantity']), (1, 2))
        self.assertEqual(stock.stock_summary(self.conn, self.item, self.location)['on_hand'], 10)

    def test_legacy_shipment_projects_header_order_instead_of_customer_line_key(self):
        receipt = self.reserve_receipt()
        shipment = stock.create_shipment(self.conn, 'LEGACY-1', self.key('legacy'))
        stock.add_shipment_line(self.conn, shipment['shipment_id'], receipt['reservation_id'], 2,
                                self.key('legacy-line'))
        workspace = self.get('/workspace')
        summary = next(row for row in workspace['shipments'] if row['shipment_id'] == shipment['shipment_id'])
        self.assertEqual(summary['order_ref'], 'customer-order-a')
        reservation = next(row for row in workspace['reservations']
                           if row['reservation_id'] == receipt['reservation_id'])
        self.assertEqual(reservation['order_ref'], 'customer-order-a')
        detail = self.get(f'/shipments/{shipment["shipment_id"]}')
        self.assertEqual(detail['order_ref'], 'customer-order-a')

    def test_failed_second_dispatch_line_rolls_back_first_line_and_retry_can_succeed(self):
        first = self.reserve_receipt(quantity=2)
        other_item = self.bind('item', 'teddy', {'name': 'Teddy bear'})
        other_demand = self.demand(other_item, 2, 'customer-order-a')
        stock.track_lots(self.conn, other_item, self.key('track'))
        second = self.reserve_receipt(other_demand, 2, other_item,
                                      lot_number='TEDDY-LOT', as_of=date.today())
        shipment_id = self.draft()
        self.add_line(shipment_id, first['reservation_id'], 2)
        self.add_line(shipment_id, second['reservation_id'], 2)
        stock.hold_lot(self.conn, second['lot_id'], 'Inspect packaging', self.key('hold'))
        count = self.movement_count()
        body = self.dispatch_body()
        self.post(f'/shipments/{shipment_id}/dispatch', body, 409)
        self.assertEqual(self.movement_count(), count)
        self.assertEqual(stock.stock_summary(self.conn, self.item, self.location)['on_hand'], 2)
        self.assertEqual(self.get(f'/shipments/{shipment_id}')['status'], 'draft')
        self.assertEqual(self.conn.execute('SELECT quantity_shipped FROM logistics.stock_reservations WHERE id=%s',
                         (first['reservation_id'],)).fetchone()['quantity_shipped'], 0)
        self.assertEqual(self.conn.execute('SELECT count(*) AS n FROM logistics.command_requests WHERE idempotency_key=%s',
                         (body['idempotency_key'],)).fetchone()['n'], 0)
        stock.release_hold(self.conn, second['lot_id'], 'Packaging checked', self.key('release'))
        self.post(f'/shipments/{shipment_id}/dispatch', body, 200)
        self.assertEqual(self.movement_count(), count + 2)

    def test_carrier_events_derive_states_keep_delivery_terminal_and_change_no_stock(self):
        receipt = self.reserve_receipt()
        shipment_id = self.draft()
        self.add_line(shipment_id, receipt['reservation_id'], 6)
        event_path = f'/shipments/{shipment_id}/events'
        stamp = date.today().isoformat()
        self.post(event_path, dict(event='in_transit', occurred_at=stamp + 'T09:00:00Z',
                                  idempotency_key='too-early'), 409)
        self.post(f'/shipments/{shipment_id}/dispatch', self.dispatch_body(), 200)
        count = self.movement_count()
        for event, hour, state in [('in_transit', 10, 'in_transit'),
                                    ('delivery_failed', 11, 'exception'),
                                    ('out_for_delivery', 12, 'in_transit'),
                                    ('delivered', 13, 'delivered'),
                                    ('exception', 14, 'delivered')]:
            body = dict(event=event, occurred_at=f'{stamp}T{hour}:00:00Z',
                        detail='Manual carrier update', idempotency_key=f'event-{hour}')
            result = self.post(event_path, body)
            self.assertEqual(result['status'], state)
            self.assertEqual(self.post(event_path, body), result)
            self.assertEqual(self.get(f'/shipments/{shipment_id}')['status'], state)
            self.assertEqual(self.movement_count(), count)
        detail = self.get(f'/shipments/{shipment_id}')
        self.assertEqual(len(detail['events']), 5)
        self.assertEqual(stock.stock_summary(self.conn, self.item, self.location)['on_hand'], 0)
        order = next(row for row in self.get('/workspace')['orders'] if row['order_ref'] == 'customer-order-a')
        self.assertEqual(order['lines'][0]['delivered'], 6)

    def test_manual_label_reference_is_sufficient_and_missing_reference_is_rejected(self):
        receipt = self.reserve_receipt()
        shipment_id = self.draft()
        self.add_line(shipment_id, receipt['reservation_id'], 2)
        self.post(f'/shipments/{shipment_id}/dispatch', dict(carrier='Local courier',
            as_of=date.today().isoformat(), idempotency_key='no-document'), 422)
        self.assertEqual(self.get(f'/shipments/{shipment_id}')['status'], 'draft')
        self.post(f'/shipments/{shipment_id}/dispatch', dict(carrier='Local courier',
            as_of=date.today().isoformat(), label_ref='HAND-LABEL-1', idempotency_key='with-label'), 200)
        self.assertEqual(self.get(f'/shipments/{shipment_id}')['label_ref'], 'HAND-LABEL-1')

    def test_parallel_dispatch_requests_with_fresh_keys_ship_stock_only_once(self):
        receipt = self.reserve_receipt()
        shipment_id = self.draft()
        self.add_line(shipment_id, receipt['reservation_id'], 6)
        barrier = Barrier(2)

        def dispatch(index):
            client = TestClient(self.client.app, raise_server_exceptions=False)
            body = dict(carrier='Example carrier', as_of=date.today().isoformat(),
                        tracking_ref='RACE-TRACK', idempotency_key=f'racing-dispatch-{index}')
            barrier.wait(timeout=5)
            return client.post(f'/api/fulfillment/shipments/{shipment_id}/dispatch',
                               headers=self.auth, json=body)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(dispatch, range(2)))
        self.assertEqual(sorted(response.status_code for response in results), [200, 409])
        levels = stock.stock_summary(self.conn, self.item, self.location)
        self.assertEqual((levels['on_hand'], levels['reserved'], levels['available']), (0, 0, 0))
        moved = self.conn.execute("""SELECT count(*) AS movements,COALESCE(-sum(quantity),0) AS quantity
            FROM logistics.stock_movements WHERE shipment_id=%s AND movement_type='shipment'""",
            (shipment_id,)).fetchone()
        self.assertEqual((moved['movements'], moved['quantity']), (1, 6))
        self.assertEqual(self.conn.execute('SELECT count(*) AS n FROM logistics.shipment_dispatches WHERE shipment_id=%s',
                         (shipment_id,)).fetchone()['n'], 1)

    def test_owner_auth_business_identity_missing_ids_and_timezone_are_enforced(self):
        for path in ('/workspace', '/shipments', '/shipments/1'):
            self.assertEqual(self.client.get('/api/fulfillment' + path).status_code, 401)
        self.assertEqual(self.client.get('/api/fulfillment/shipments/99999', headers=self.auth).status_code, 404)
        self.post('/shipments', dict(order_ref='made-up-order', shipment_number='BAD-ORDER',
            idempotency_key='unknown-order'), 422)
        self.post('/shipments/99999/dispatch', self.dispatch_body(), 404)
        wrong = TestClient(create_app(Settings(self.dsn, 'another-business', 'owner-token', 'owner')),
                           raise_server_exceptions=False)
        response = wrong.get('/api/fulfillment/workspace', headers=self.auth)
        self.assertEqual(response.status_code, 403, response.text)
        shipment_id = self.draft()
        self.post(f'/shipments/{shipment_id}/events', dict(event='in_transit',
            occurred_at='2026-10-30T09:00:00', idempotency_key='naive-event'), 422)

    def test_workspace_enriches_submitted_local_orders_with_customer_details(self):
        records.configure(self.conn, business_name='Toy shop', currency='USD', idempotency_key='setup')
        customer = records.create_record(self.conn, table_slug='customers', values={'name': 'Toy customer'},
                                         idempotency_key='customer')['record']
        item = records.create_record(self.conn, table_slug='items', values={'name': 'Train', 'sku': 'TRAIN'},
                                     idempotency_key='item')['record']
        order = records.create_record(self.conn, table_slug='customer_orders', values={
            'order_number': 'SO-LOCAL-1', 'customer_id': customer['id'], 'order_date': date.today().isoformat(),
            'currency': 'USD', 'ship_to_address': '1 Toy Street'}, idempotency_key='local-order')['record']
        records.create_record(self.conn, table_slug='customer_order_lines', values={
            'order_id': order['id'], 'item_id': item['id'], 'quantity': 3, 'unit_price_minor': 1200},
            idempotency_key='local-line')
        records.submit_customer_order(self.conn, record_id=order['id'], expected_version=order['version'],
                                       idempotency_key='submit-local-order')
        projected = next(row for row in self.get('/workspace')['orders']
                         if row['order_ref'] == f'local:customer_orders:{order["id"]}')
        self.assertEqual(projected['order_number'], 'SO-LOCAL-1')
        self.assertEqual(projected['customer_name'], 'Toy customer')
        self.assertEqual(projected['ship_to_address'], '1 Toy Street')
        self.assertEqual(projected['lines'][0]['quantity'], 3)
