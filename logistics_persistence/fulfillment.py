"""Shipping read projections and a thin adapter to the existing stock commands.

This module does not write shipment, reservation or ledger rows itself. Mutations
retain stock.py's transactions, locks, command identities and replay results.
"""
from __future__ import annotations

from contextlib import contextmanager

from . import records, stock
from .errors import NotFound, ValidationError


@contextmanager
def _snapshot(conn):
    """One committed point in time for related shipping quantities and states."""
    with conn.transaction():
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        yield


def _reservations(conn):
    return [dict(row) for row in conn.execute("""
        SELECT r.id AS reservation_id,r.item_id,r.location_id,
            COALESCE(d.order_ref,r.order_ref) AS order_ref,r.demand_line_id,
            r.status,r.quantity,r.quantity_shipped,
            CASE WHEN r.status='active' THEN r.quantity-r.quantity_shipped ELSE 0 END AS remaining_quantity,
            COALESCE(p.quantity,0)::bigint AS planned_quantity,
            CASE WHEN r.status='active' THEN
                GREATEST(0,r.quantity-r.quantity_shipped-COALESCE(p.quantity,0)) ELSE 0 END::bigint AS available_to_plan
        FROM logistics.stock_reservations r
        LEFT JOIN logistics.demand_lines d ON d.id=r.demand_line_id
        LEFT JOIN (
            SELECT l.reservation_id,sum(l.quantity) AS quantity
            FROM logistics.shipment_lines l
            WHERE NOT EXISTS(SELECT 1 FROM logistics.shipment_dispatches x WHERE x.shipment_id=l.shipment_id)
            GROUP BY l.reservation_id
        ) p ON p.reservation_id=r.id
        ORDER BY r.id
    """).fetchall()]


def _shipments(conn):
    return [dict(row) for row in conn.execute("""
        SELECT s.shipment_id,s.shipment_number,
            COALESCE(s.order_ref,(
                SELECT COALESCE(d.order_ref,r.order_ref)
                FROM logistics.shipment_lines l
                JOIN logistics.stock_reservations r ON r.id=l.reservation_id
                LEFT JOIN logistics.demand_lines d ON d.id=r.demand_line_id
                WHERE l.shipment_id=s.shipment_id ORDER BY l.id LIMIT 1
            )) AS order_ref,
            s.status,s.carrier,s.label_ref,s.tracking_ref,s.dispatched_on,
            COALESCE(lines.line_count,0)::bigint AS line_count,
            COALESCE(lines.total_quantity,0)::bigint AS total_quantity
        FROM logistics.shipment_status s
        LEFT JOIN (
            SELECT shipment_id,count(*) AS line_count,sum(quantity) AS total_quantity
            FROM logistics.shipment_lines GROUP BY shipment_id
        ) lines ON lines.shipment_id=s.shipment_id
        ORDER BY s.shipment_id DESC
    """).fetchall()]


def _local_order_labels(conn):
    names = conn.execute("""SELECT
        to_regclass('logistics.record_customer_orders') AS orders,
        to_regclass('logistics.record_customers') AS customers""").fetchone()
    if not names['orders'] or not names['customers']:
        return {}
    return {f"local:customer_orders:{row['id']}": dict(row) for row in conn.execute("""
        SELECT o.id,o.order_number,o.ship_to_address,c.name AS customer_name
        FROM logistics.record_customer_orders o
        JOIN logistics.record_customers c ON c.id=o.customer_id
        WHERE o._submitted_at IS NOT NULL ORDER BY o.id
    """).fetchall()}


def _orders(conn, reservations, shipments):
    labels = _local_order_labels(conn)
    result = {}

    def order(reference):
        if reference not in result:
            local = labels.get(reference, {})
            result[reference] = {
                'order_ref': reference, 'order_number': local.get('order_number', reference),
                'customer_name': local.get('customer_name'),
                'ship_to_address': local.get('ship_to_address'), 'lines': [],
            }
        return result[reference]

    for row in conn.execute("""SELECT demand_line_id,order_ref,item_id,quantity,
        reserved,shipped,delivered,status FROM logistics.demand_fulfillment ORDER BY demand_line_id""").fetchall():
        line = dict(row)
        order(line.pop('order_ref'))['lines'].append(line)
    for reservation in reservations:
        target = order(reservation['order_ref'])
        if reservation['demand_line_id'] is None:
            # Legacy stock commands accept order references without core demand.
            target['lines'].append({
                'demand_line_id': None, 'item_id': reservation['item_id'],
                'quantity': reservation['quantity'], 'reserved': reservation['remaining_quantity'],
                'shipped': reservation['quantity_shipped'], 'delivered': None,
                'status': 'shipped' if reservation['status'] == 'fulfilled' else 'allocated'
                    if reservation['status'] == 'active' else 'released',
            })
    for summary in shipments:
        if summary['order_ref']:
            order(summary['order_ref'])
    return list(result.values())


def workspace(conn):
    with _snapshot(conn):
        reservations = _reservations(conn)
        shipments = _shipments(conn)
        references = [dict(row) for row in conn.execute(
            'SELECT * FROM logistics.core_bindings ORDER BY id').fetchall()]
        references = records.decorate_references(conn, references)
        levels = [dict(row) for row in conn.execute("""
            SELECT item_id,location_id,on_hand,reserved,on_hand-reserved AS available
            FROM logistics.stock_levels ORDER BY item_id,location_id
        """).fetchall()]
        return {'orders': _orders(conn, reservations, shipments), 'reservations': reservations,
                'shipments': shipments, 'stock': levels, 'references': references}


def list_shipments(conn):
    with _snapshot(conn):
        return {'shipments': _shipments(conn)}


def shipment(conn, shipment_id):
    with _snapshot(conn):
        result = stock.shipment(conn, shipment_id)
        rows = conn.execute("""
            SELECT l.id AS line_id,r.location_id,r.demand_line_id,
                COALESCE(d.order_ref,r.order_ref) AS order_ref
            FROM logistics.shipment_lines l
            JOIN logistics.stock_reservations r ON r.id=l.reservation_id
            LEFT JOIN logistics.demand_lines d ON d.id=r.demand_line_id
            WHERE l.shipment_id=%s ORDER BY l.id
        """, (shipment_id,)).fetchall()
        details = {row['line_id']: row for row in rows}
        for line in result['lines']:
            line.update(dict(details[line['line_id']]))
        if result['order_ref'] is None and rows:
            result['order_ref'] = rows[0]['order_ref']
        return result


def _require_shipment(conn, shipment_id):
    if conn.execute('SELECT 1 FROM logistics.shipments WHERE id=%s', (shipment_id,)).fetchone() is None:
        raise NotFound('Shipment not found')


def create_shipment(conn, *, shipment_number, order_ref, idempotency_key):
    known = conn.execute("""SELECT EXISTS(
        SELECT 1 FROM logistics.demand_lines WHERE order_ref=%s
        UNION ALL SELECT 1 FROM logistics.stock_reservations r
        LEFT JOIN logistics.demand_lines d ON d.id=r.demand_line_id
        WHERE COALESCE(d.order_ref,r.order_ref)=%s
    ) AS known""", (order_ref, order_ref)).fetchone()['known']
    if not known:
        raise ValidationError('Choose an existing customer order before creating a shipment')
    return stock.create_shipment(conn, shipment_number, idempotency_key, order_ref=order_ref)


def reserve_stock(conn, *, demand_line_id, quantity, idempotency_key, location_id=None, as_of=None):
    """Reserve free stock for one customer order line.

    Reserves what is free and reports the shortage; it creates no purchase and no stock.
    The database refuses a reservation above what the order line still needs, and the
    check runs inside the stock command so a retry with the same key replays safely.
    """
    line = conn.execute("SELECT id,item_id,external_key FROM logistics.demand_lines WHERE id=%s",
                        (demand_line_id,)).fetchone()
    if line is None:
        raise NotFound('Customer order line not found')
    return stock.reserve(conn, line["item_id"], quantity, line["external_key"], idempotency_key, as_of,
                         location_id=location_id, demand_line_id=demand_line_id)


def release_reservation(conn, *, reservation_id, idempotency_key):
    return stock.release(conn, reservation_id, idempotency_key)


def add_shipment_line(conn, *, shipment_id, reservation_id, quantity, idempotency_key):
    _require_shipment(conn, shipment_id)
    return stock.add_shipment_line(conn, shipment_id, reservation_id, quantity, idempotency_key)


def dispatch(conn, *, shipment_id, carrier, as_of, idempotency_key, label_ref=None, tracking_ref=None):
    _require_shipment(conn, shipment_id)
    return stock.dispatch(conn, shipment_id, carrier, idempotency_key, as_of,
                          label_ref=label_ref, tracking_ref=tracking_ref)


def record_tracking_event(conn, *, shipment_id, event, occurred_at, idempotency_key, detail=None):
    _require_shipment(conn, shipment_id)
    return stock.record_tracking_event(conn, shipment_id, event, occurred_at,
                                       idempotency_key, detail=detail)
