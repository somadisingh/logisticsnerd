"""Expiry risk HTTP tests against real, isolated PostgreSQL."""
from fastapi.testclient import TestClient
from logistics_persistence import stock
from logistics_persistence.api import Settings, create_app
from logistics_persistence.stock_risk import lot_risks
from logistics_persistence.errors import ValidationError
from .common import PostgresCase


class LotRiskTests(PostgresCase):
    def setUp(self):
        super().setUp()
        self.item=self.bind('item','milk')
        self.loc=self.bind('location','cold')
        self.other=self.bind('location','other')
        stock.track_lots(self.conn,self.item,self.key())
        self.client=TestClient(create_app(Settings(self.dsn,'test-business','token','owner')))
        self.auth={'Authorization':'Bearer token'}

    def receive(self,name,expiry,quantity=5,location=None):
        return stock.receive(self.conn,self.item,quantity,name,self.key(),lot_number=name,
                             expiry_date=expiry,location_id=location or self.loc)

    def report(self,**kw):
        return lot_risks(self.conn,as_of='2026-11-04',**kw)

    def test_date_boundaries_and_nonexpiring_exclusion(self):
        for name,exp in [('old','2026-11-03'),('today','2026-11-04'),
                         ('end','2026-12-04'),('later','2026-12-05'),('none',None)]:
            self.receive(name,exp)
        r=self.report()
        self.assertEqual({x['lot_number']:x['risk'] for x in r['lots']},
                         {'old':'expired','today':'expiring','end':'expiring'})
        self.assertEqual(r['on_hand_by_risk'],{'held':0,'expired':5,'expiring':10})

    def test_held_overrides_expired_without_double_count(self):
        r=self.receive('old','2026-11-03')
        stock.hold_lot(self.conn,r['lot_id'],'check',self.key())
        self.assertEqual(self.report()['on_hand_by_risk'],{'held':5,'expired':0,'expiring':0})

    def test_nonexpiring_held_lot_is_included(self):
        r=self.receive('none',None)
        stock.hold_lot(self.conn,r['lot_id'],'check',self.key())
        self.assertEqual(self.report()['lots'][0]['risk'],'held')

    def test_released_hold_returns_to_date_classification(self):
        r=self.receive('old','2026-11-03')
        stock.hold_lot(self.conn,r['lot_id'],'check',self.key())
        stock.release_hold(self.conn,r['lot_id'],'cleared',self.key())
        self.assertEqual(self.report()['lots'][0]['risk'],'expired')

    def test_location_balances_do_not_bleed(self):
        self.receive('same','2026-11-05',3)
        self.receive('same','2026-11-05',7,self.other)
        r=self.report(location_id=self.loc)
        self.assertEqual(r['on_hand_by_risk']['expiring'],3)
        self.assertEqual(len(r['lots']),1)

    def test_reserved_and_partial_shipped_projection(self):
        self.receive('soon','2026-11-05',10)
        r=stock.reserve(self.conn,self.item,6,'order',self.key(),as_of='2026-11-04',location_id=self.loc)
        stock.ship(self.conn,r['reservation_id'],2,self.key(),as_of='2026-11-04')
        row=self.report()['lots'][0]
        self.assertEqual((row['on_hand'],row['allocated'],row['unallocated']), (8,4,4))

    def test_depleted_lot_excluded(self):
        self.receive('soon','2026-11-05',2)
        r=stock.reserve(self.conn,self.item,2,'order',self.key(),as_of='2026-11-04',location_id=self.loc)
        stock.ship(self.conn,r['reservation_id'],2,self.key(),as_of='2026-11-04')
        self.assertEqual(self.report()['lots'],[])

    def test_zero_horizon(self):
        self.receive('today','2026-11-04')
        self.receive('tomorrow','2026-11-05')
        self.assertEqual(len(self.report(horizon_days=0)['lots']),1)

    def test_item_filter_and_empty(self):
        self.receive('soon','2026-11-05')
        self.assertEqual(self.report(item_id=self.item)['on_hand_by_risk']['expiring'],5)
        self.assertEqual(self.report(item_id=999)['lots'],[])

    def test_http_auth_validation_and_serialization(self):
        self.receive('soon','2026-11-05')
        path='/api/purchasing/lot-risks?as_of=2026-11-04'
        self.assertEqual(self.client.get(path).status_code,401)
        r=self.client.get(path,headers=self.auth)
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()['lots'][0]['expiry_date'],'2026-11-05')
        for query in ('horizon_days=-1','horizon_days=367','location_id=0','item_id=0'):
            self.assertEqual(self.client.get(path+'&'+query,headers=self.auth).status_code,422)
        self.assertEqual(self.client.get('/api/purchasing/lot-risks',headers=self.auth).status_code,422)

    def test_read_only_and_current_balance_label(self):
        self.receive('soon','2026-11-05')
        before=self.conn.execute('SELECT count(*) n FROM logistics.command_requests').fetchone()['n']
        summary_before=stock.stock_summary(self.conn,self.item,self.loc)
        r=self.report()
        self.assertEqual(stock.stock_summary(self.conn,self.item,self.loc),summary_before)
        self.assertEqual(r['balance_basis'],'current')
        self.assertEqual(self.report(),r)
        self.assertEqual(self.conn.execute('SELECT count(*) n FROM logistics.command_requests').fetchone()['n'],before)

    def test_direct_invalid_inputs(self):
        for args in ({'as_of':None},{'as_of':'bad'},{'as_of':'2026-11-04','horizon_days':True},
                     {'as_of':'9999-12-31','horizon_days':1}):
            with self.assertRaises(ValidationError): lot_risks(self.conn,**args)
