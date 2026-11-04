"""Read-only per-location lot risk queue, derived from the immutable ledger."""
from datetime import date, timedelta
from .errors import ValidationError
from .stock import _date, _int


def lot_risks(conn, *, as_of, horizon_days=30, location_id=None, item_id=None):
    """List nonempty expired, soon-expiring and held lots without overlap.

    as_of is a classification date, NOT an historical inventory snapshot.
    Balances are current. Date boundaries are inclusive. Held takes precedence
    over expired/expiring so each physical unit contributes exactly once.
    """
    day = _date('as_of', as_of)
    if day is None:
        raise ValidationError('as_of is required')
    if isinstance(horizon_days, bool) or not isinstance(horizon_days, int) or not 0 <= horizon_days <= 366:
        raise ValidationError('horizon_days must be an integer from 0 to 366')
    if location_id is not None:
        _int('location_id', location_id)
    if item_id is not None:
        _int('item_id', item_id)
    try:
        end = date.fromisoformat(day) + timedelta(days=horizon_days)
    except OverflowError:
        raise ValidationError('horizon exceeds the supported date range') from None
    # Single SQL statement gives a coherent ledger snapshot even at READ COMMITTED.
    rows = conn.execute('''
        WITH balances AS (
          SELECT lot_id,item_id,location_id,sum(quantity)::bigint AS on_hand
          FROM logistics.stock_movements WHERE lot_id IS NOT NULL
          GROUP BY lot_id,item_id,location_id
        ), allocations AS (
          SELECT a.lot_id,r.location_id,sum(a.quantity)::bigint AS allocated
          FROM logistics.lot_allocations a JOIN logistics.stock_reservations r ON r.id=a.reservation_id
          WHERE r.status='active' GROUP BY a.lot_id,r.location_id
        ), shipped AS (
          SELECT m.lot_id,m.location_id,sum(m.quantity)::bigint AS delta
          FROM logistics.stock_movements m JOIN logistics.stock_reservations r ON r.id=m.reservation_id
          WHERE m.lot_id IS NOT NULL AND r.status='active' GROUP BY m.lot_id,m.location_id
        )
        SELECT b.*,l.lot_number,l.expiry_date,
          COALESCE(a.allocated,0)+COALESCE(s.delta,0) AS allocated,
          COALESCE((SELECT h.event='hold' FROM logistics.stock_lot_holds h
                    WHERE h.lot_id=b.lot_id ORDER BY h.id DESC LIMIT 1),false) AS on_hold
        FROM balances b JOIN logistics.stock_lots l ON l.id=b.lot_id
        LEFT JOIN allocations a ON a.lot_id=b.lot_id AND a.location_id=b.location_id
        LEFT JOIN shipped s ON s.lot_id=b.lot_id AND s.location_id=b.location_id
        WHERE b.on_hand>0 AND (%s::bigint IS NULL OR b.location_id=%s)
          AND (%s::bigint IS NULL OR b.item_id=%s)
        ORDER BY l.expiry_date NULLS LAST,b.item_id,b.location_id,b.lot_id
    ''', (location_id,location_id,item_id,item_id)).fetchall()
    result=[]
    totals={'held':0,'expired':0,'expiring':0}
    for row in rows:
        row=dict(row)
        expiry=row['expiry_date']
        risk = ('held' if row['on_hold'] else 'expired' if expiry and expiry < date.fromisoformat(day)
                else 'expiring' if expiry and expiry <= end else None)
        if risk is None:
            continue
        row['risk']=risk
        row['unallocated']=max(0,row['on_hand']-row['allocated'])
        row['usable_available']=0 if risk in ('held','expired') else row['unallocated']
        totals[risk]+=row['on_hand']
        result.append(row)
    return {'as_of':day,'through':end.isoformat(),'balance_basis':'current',
            'horizon_days':horizon_days,'lots':result,'on_hand_by_risk':totals}
