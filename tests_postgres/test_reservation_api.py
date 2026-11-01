"""Real PostgreSQL tests for reserving and releasing stock through the fulfillment HTTP API."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from threading import Barrier

from fastapi.testclient import TestClient

from logistics_persistence import stock
from logistics_persistence.api import Settings, create_app
from .common import PostgresCase


class ReservationApiTests(PostgresCase):
    def setUp(self):
        super().setUp()
        self.item = self.bind('item', 'robot', {'name': 'Blue robot'})
        self.location = self.bind('location', 'warehouse', {'name': 'Toy warehouse'})
        self.bind('actor', 'owner', {'name': 'Owner', 'can_approve_purchases': True})
        self.demand_a = self.demand(self.item, 6, 'customer-order-a')
        self.demand_b = self.demand(self.item, 4, 'customer-order-b')
        self.client = TestClient(create_app(Settings(self.dsn, 'test-business', 'owner-token', 'owner')),
                                 raise_server_exceptions=False)
        self.auth = {'Authorization': 'Bearer owner-token'}

    def open(self, quantity):
        return stock.open_stock(self.conn, self.item, quantity, self.key('open'), self.key('open'),
                                location_id=self.location)

    def call(self, path, body, status, headers=True):
        response = self.client.post('/api/fulfillment' + path, headers=self.auth if headers else {}, json=body)
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def reserve(self, demand, quantity, status=201, key=None, **extra):
        return self.call('/reservations', dict(demand_line_id=demand, quantity=quantity,
                         idempotency_key=key or self.key('reserve'), location_id=self.location, **extra), status)

    def levels(self):
        s = stock.stock_summary(self.conn, self.item, self.location)
        return s['on_hand'], s['reserved'], s['available']

    def rows(self, table='stock_reservations'):
        return self.conn.execute(f'SELECT count(*) AS n FROM logistics.{table}').fetchone()['n']

    def test_reserve_free_stock_for_order_line_moves_available_not_on_hand(self):
        self.open(10)
        result = self.reserve(self.demand_a, 4)
        self.assertEqual((result['requested'], result['reserved'], result['shortage']), (4, 4, 0))
        self.assertEqual(self.levels(), (10, 4, 6))
        self.assertEqual(self.rows('stock_movements'), 1)

    def test_reservation_is_tied_to_the_demand_line_and_shows_in_workspace(self):
        self.open(10)
        rid = self.reserve(self.demand_a, 4)['reservation_id']
        workspace = self.client.get('/api/fulfillment/workspace', headers=self.auth).json()
        row = next(r for r in workspace['reservations'] if r['reservation_id'] == rid)
        self.assertEqual((row['demand_line_id'], row['order_ref'], row['remaining_quantity']),
                         (self.demand_a, 'customer-order-a', 4))

    def test_partial_stock_reserves_what_is_free_and_reports_the_shortage(self):
        self.open(3)
        result = self.reserve(self.demand_a, 5)
        self.assertEqual((result['reserved'], result['shortage']), (3, 2))
        self.assertEqual(self.levels(), (3, 3, 0))

    def test_no_free_stock_creates_no_reservation_and_reports_full_shortage(self):
        result = self.reserve(self.demand_a, 2)
        self.assertEqual((result['reservation_id'], result['reserved'], result['shortage']), (None, 0, 2))
        self.assertEqual(self.rows(), 0)

    def test_same_key_replays_one_reservation(self):
        self.open(10)
        first = self.reserve(self.demand_a, 4, key='same')
        second = self.reserve(self.demand_a, 4, key='same')
        self.assertEqual(first, second)
        self.assertEqual((self.rows(), self.levels()), (1, (10, 4, 6)))

    def test_unknown_order_line_is_not_found_and_changes_nothing(self):
        self.open(10)
        self.reserve(999999, 1, status=404)
        self.assertEqual((self.rows(), self.levels()), (0, (10, 0, 10)))

    def test_cannot_reserve_more_than_the_order_line_still_needs(self):
        self.open(20)
        self.reserve(self.demand_a, 7, status=422)
        self.reserve(self.demand_a, 6)
        self.assertEqual(self.levels(), (20, 6, 14))

    def test_fully_reserved_line_refuses_another_reservation(self):
        self.open(20)
        self.reserve(self.demand_a, 6)
        self.reserve(self.demand_a, 1, status=422)
        self.assertEqual(self.rows(), 1)

    def test_authentication_comes_before_database_access(self):
        self.open(10)
        self.call('/reservations', dict(demand_line_id=self.demand_a, quantity=1, idempotency_key='k'), 401, headers=False)
        self.call('/reservations/1/release', dict(idempotency_key='k'), 401, headers=False)
        self.assertEqual(self.rows(), 0)

    def test_strict_input_is_rejected_before_any_write(self):
        self.open(10)
        good = dict(demand_line_id=self.demand_a, quantity=1, idempotency_key='k')
        for bad in (dict(good, quantity=0), dict(good, quantity=True), dict(good, demand_line_id=0),
                    dict(good, surprise=1), {k: v for k, v in good.items() if k != 'idempotency_key'},
                    dict(good, as_of='2026-13-45')):
            self.call('/reservations', bad, 422)
        self.assertEqual(self.rows(), 0)

    def test_release_frees_stock_and_never_touches_on_hand(self):
        self.open(10)
        rid = self.reserve(self.demand_a, 4)['reservation_id']
        result = self.call(f'/reservations/{rid}/release', dict(idempotency_key=self.key('rel')), 200)
        self.assertEqual((result['released'], result['status']), (4, 'released'))
        self.assertEqual(self.levels(), (10, 0, 10))

    def test_release_replays_and_a_second_release_conflicts(self):
        self.open(10)
        rid = self.reserve(self.demand_a, 4)['reservation_id']
        first = self.call(f'/reservations/{rid}/release', dict(idempotency_key='rel'), 200)
        self.assertEqual(self.call(f'/reservations/{rid}/release', dict(idempotency_key='rel'), 200), first)
        self.call(f'/reservations/{rid}/release', dict(idempotency_key='rel2'), 409)
        self.call('/reservations/999999/release', dict(idempotency_key='rel3'), 404)

    def test_released_stock_can_be_reserved_again_and_released_line_cannot_ship(self):
        self.open(6)
        rid = self.reserve(self.demand_a, 6)['reservation_id']
        shipment = self.call('/shipments', dict(shipment_number='S1', order_ref='customer-order-a',
                             idempotency_key=self.key('ship')), 201)['shipment_id']
        self.call(f'/reservations/{rid}/release', dict(idempotency_key='rel'), 200)
        self.call(f'/shipments/{shipment}/lines', dict(reservation_id=rid, quantity=1,
                  idempotency_key=self.key('line')), 409)
        self.assertEqual(self.reserve(self.demand_b, 4)['reserved'], 4)
        self.assertEqual(self.levels(), (6, 4, 2))

    def test_reserve_then_ship_through_http_changes_on_hand_once(self):
        self.open(10)
        rid = self.reserve(self.demand_a, 4)['reservation_id']
        shipment = self.call('/shipments', dict(shipment_number='S2', order_ref='customer-order-a',
                             idempotency_key=self.key('ship')), 201)['shipment_id']
        self.call(f'/shipments/{shipment}/lines', dict(reservation_id=rid, quantity=4,
                  idempotency_key=self.key('line')), 201)
        self.call(f'/shipments/{shipment}/dispatch', dict(carrier='Example carrier',
                  as_of=date.today().isoformat(), tracking_ref='T1', idempotency_key=self.key('d')), 200)
        self.assertEqual(self.levels(), (6, 0, 6))

    def test_parallel_requests_cannot_reserve_the_last_unit_twice(self):
        self.open(1)
        barrier = Barrier(2)

        def attempt(demand):
            barrier.wait()
            client = TestClient(create_app(Settings(self.dsn, 'test-business', 'owner-token', 'owner')),
                                raise_server_exceptions=False)
            return client.post('/api/fulfillment/reservations', headers=self.auth, json=dict(
                demand_line_id=demand, quantity=1, location_id=self.location,
                idempotency_key=self.key('par')))

        with ThreadPoolExecutor(2) as pool:
            responses = list(pool.map(attempt, (self.demand_a, self.demand_b)))
        self.assertEqual([r.status_code for r in responses], [201, 201], [r.text for r in responses])
        self.assertEqual(sorted(r.json()['reserved'] for r in responses), [0, 1])
        self.assertEqual(self.levels(), (1, 1, 0))

    def test_reservation_uses_the_requested_location_when_two_exist(self):
        other = self.bind('location', 'store', {'name': 'Store'})
        stock.open_stock(self.conn, self.item, 5, self.key('open'), self.key('open'), location_id=other)
        result = self.call('/reservations', dict(demand_line_id=self.demand_a, quantity=3, location_id=other,
                           idempotency_key=self.key('r')), 201)
        self.assertEqual((result['location_id'], result['reserved']), (other, 3))
        self.assertEqual(stock.stock_summary(self.conn, self.item, other)['reserved'], 3)
        self.assertEqual(stock.stock_summary(self.conn, self.item, self.location)['reserved'], 0)

    def test_location_is_required_when_two_exist_and_nothing_is_written(self):
        other = self.bind('location', 'store', {'name': 'Store'})
        stock.open_stock(self.conn, self.item, 5, self.key('open'), self.key('open'), location_id=other)
        self.call('/reservations', dict(demand_line_id=self.demand_a, quantity=1, idempotency_key=self.key('r')), 422)
        self.assertEqual(self.rows(), 0)

    def test_release_body_is_strict(self):
        self.open(10)
        rid = self.reserve(self.demand_a, 4)['reservation_id']
        self.call(f'/reservations/{rid}/release', dict(idempotency_key='x', surprise=1), 422)
        self.call(f'/reservations/{rid}/release', {}, 422)
        self.assertEqual(self.levels(), (10, 4, 6))
