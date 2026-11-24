"""Read current lot balances and classify their risk on a given date."""
from datetime import date, timedelta

from .errors import ValidationError
from .stock import _date, _int


def lot_risks(conn, *, as_of, horizon_days=30, location_id=None, item_id=None):
    """List held, expired, and expiring lots with current stock."""
    day = _date('as_of', as_of)
    if day is None:
        raise ValidationError('as_of is required')
    if type(horizon_days) is not int or not 0 <= horizon_days <= 366:
        raise ValidationError('horizon_days must be an integer from 0 to 366')
    for name, value in (('location_id', location_id), ('item_id', item_id)):
        if value is not None and _int(name, value) > 2**63 - 1:
            raise ValidationError(f'{name} exceeds the supported ID range')
    try:
        through = (date.fromisoformat(day) + timedelta(days=horizon_days)).isoformat()
    except OverflowError:
        raise ValidationError('horizon exceeds the supported date range') from None

    # Read balances and holds in one statement so they use the same snapshot.
    rows = conn.execute('''
        WITH risky_lots AS (
          SELECT lot_id,item_id,lot_number,expiry_date,on_hold,
            CASE WHEN on_hold THEN 'held'
                 WHEN expiry_date < %(day)s::date THEN 'expired'
                 ELSE 'expiring' END AS risk
          FROM logistics.stock_lot_levels
          WHERE (on_hold OR expiry_date <= %(through)s::date)
            AND (%(item_id)s::bigint IS NULL OR item_id=%(item_id)s)
        ), balances AS (
          SELECT m.lot_id,m.location_id,sum(m.quantity)::bigint AS on_hand,
            sum(m.quantity) FILTER (WHERE r.status='active')::bigint AS shipped_delta
          FROM logistics.stock_movements m JOIN risky_lots l ON l.lot_id=m.lot_id
          LEFT JOIN logistics.stock_reservations r ON r.id=m.reservation_id
          WHERE (%(location_id)s::bigint IS NULL OR m.location_id=%(location_id)s)
          GROUP BY m.lot_id,m.location_id HAVING sum(m.quantity)>0
        ), allocations AS (
          SELECT a.lot_id,r.location_id,sum(a.quantity)::bigint AS allocated
          FROM logistics.lot_allocations a JOIN risky_lots l ON l.lot_id=a.lot_id
          JOIN logistics.stock_reservations r ON r.id=a.reservation_id
          WHERE r.status='active'
            AND (%(location_id)s::bigint IS NULL OR r.location_id=%(location_id)s)
          GROUP BY a.lot_id,r.location_id
        )
        SELECT l.*,b.location_id,b.on_hand,
          COALESCE(a.allocated,0)+COALESCE(b.shipped_delta,0) AS allocated
        FROM risky_lots l JOIN balances b ON b.lot_id=l.lot_id
        LEFT JOIN allocations a ON a.lot_id=b.lot_id AND a.location_id=b.location_id
        ORDER BY l.expiry_date NULLS LAST,l.item_id,b.location_id,l.lot_id
    ''', {'day': day, 'through': through, 'location_id': location_id, 'item_id': item_id}).fetchall()

    totals = {'held': 0, 'expired': 0, 'expiring': 0}
    for row in rows:
        risk = row['risk']
        row['unallocated'] = max(0, row['on_hand'] - row['allocated'])
        row['usable_available'] = row['unallocated'] if risk == 'expiring' else 0
        totals[risk] += row['on_hand']
    return {
        'as_of': day, 'through': through, 'balance_basis': 'current',
        'horizon_days': horizon_days, 'lots': rows, 'on_hand_by_risk': totals,
    }
