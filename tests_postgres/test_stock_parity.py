"""Execute the pinned SQLite engine and PostgreSQL port on identical workflows."""
import importlib.util
from pathlib import Path
import tempfile

from logistics_persistence import stock
from tests_postgres.common import PostgresCase

BASELINE = Path(__file__).parent / "fixtures" / "jasmeet_stock_68554a1" / "stock.py"
spec = importlib.util.spec_from_file_location("jasmeet_stock_baseline_68554a1", BASELINE)
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)


class StockParityTests(PostgresCase):
    def setUp(self):
        super().setUp()
        self.item = self.bind("item", "chair")
        self.bind("location", "warehouse")
        self.directory = tempfile.TemporaryDirectory(prefix="logistics-sqlite-baseline-")
        self.sqlite = legacy.connect(str(Path(self.directory.name)/"business.sqlite"))
        legacy.init_db(self.sqlite)

    def tearDown(self):
        self.sqlite.close()
        self.directory.cleanup()
        super().tearDown()

    def levels(self):
        old = tuple(fn(self.sqlite,self.item) for fn in (legacy.on_hand,legacy.reserved,legacy.available))
        new = tuple(fn(self.conn,self.item) for fn in (stock.on_hand,stock.reserved,stock.available))
        self.assertEqual(old,new)
        return new

    def test_nonlot_open_reserve_partial_ship_release_and_replay(self):
        old=legacy.open_stock(self.sqlite,self.item,4,"count","opening")
        new=stock.open_stock(self.conn,self.item,4,"count","opening")
        self.assertEqual(new["quantity"],4)
        self.levels()
        before=legacy.reserve(self.sqlite,self.item,7,"line-1","reserve")
        after=stock.reserve(self.conn,self.item,7,"line-1","reserve")
        for key in ("requested","reserved","shortage"):
            self.assertEqual(before[key],after[key])
        self.assertEqual(self.levels(),(4,4,0))
        sent_old=legacy.ship(self.sqlite,before["reservation_id"],2,"ship")
        sent_new=stock.ship(self.conn,after["reservation_id"],2,"ship")
        for key in ("shipped","remaining","quantity_shipped","status"):
            self.assertEqual(sent_old[key],sent_new[key])
        self.assertEqual(stock.ship(self.conn,after["reservation_id"],2,"ship"),sent_new)
        self.assertEqual(legacy.ship(self.sqlite,before["reservation_id"],2,"ship"),sent_old)
        self.assertEqual(self.levels(),(2,2,0))
        legacy.release(self.sqlite,before["reservation_id"],"release")
        stock.release(self.conn,after["reservation_id"],"release")
        self.assertEqual(self.levels(),(2,0,2))

    def test_lot_fefo_holds_partial_ship_recall_and_expiry(self):
        legacy.track_lots(self.sqlite,self.item,"tracking")
        stock.track_lots(self.conn,self.item,"tracking")
        for number,qty,expiry in [("expired",4,"2026-01-01"),("early",3,"2026-11-01"),("late",5,None)]:
            legacy.receive(self.sqlite,self.item,qty,"PO","receive-"+number,lot_number=number,expiry_date=expiry)
            stock.receive(self.conn,self.item,qty,"PO","receive-"+number,lot_number=number,expiry_date=expiry)
        before=legacy.reserve(self.sqlite,self.item,7,"order","reserve",as_of="2026-10-27")
        after=stock.reserve(self.conn,self.item,7,"order","reserve",as_of="2026-10-27")
        self.assertEqual((before["reserved"],before["shortage"]),(after["reserved"],after["shortage"]))
        old_lots={row["lot_number"]:row for row in legacy.lots(self.sqlite,self.item,"2026-10-27")}
        new_lots={row["lot_number"]:row for row in stock.lots(self.conn,self.item,"2026-10-27")}
        legacy.hold_lot(self.sqlite,old_lots["early"]["lot_id"],"recall","hold")
        stock.hold_lot(self.conn,new_lots["early"]["lot_id"],"recall","hold")
        legacy.ship(self.sqlite,before["reservation_id"],2,"ship",as_of="2026-10-27")
        stock.ship(self.conn,after["reservation_id"],2,"ship",as_of="2026-10-27")
        self.levels()
        old_lots={row["lot_number"]:row for row in legacy.lots(self.sqlite,self.item,"2026-10-27")}
        new_lots={row["lot_number"]:row for row in stock.lots(self.conn,self.item,"2026-10-27")}
        for number in old_lots:
            for key in ("expiry_date","on_hand","allocated","free","on_hold","expired","usable"):
                self.assertEqual(old_lots[number][key],new_lots[number][key],(number,key))
        old_recall=legacy.recall(self.sqlite,old_lots["late"]["lot_id"])
        new_recall=stock.recall(self.conn,new_lots["late"]["lot_id"])
        for key in ("received","on_hand","on_hold","expiry_date"):
            self.assertEqual(old_recall[key],new_recall[key])
        self.assertEqual([(r["allocated"],r["shipped"],r["status"]) for r in old_recall["reservations"]],[(r["allocated"],r["shipped"],r["status"]) for r in new_recall["reservations"]])

    def test_receive_and_reserve_free_remainder_and_single_dispatch(self):
        before=legacy.receive_and_reserve(self.sqlite,self.item,5,"PO","order","receive",reserve_quantity=3)
        after=stock.receive_and_reserve(self.conn,self.item,5,"PO","order","receive",reserve_quantity=3)
        self.assertEqual(self.levels(),(5,3,2))
        old_shipment=legacy.create_shipment(self.sqlite,"S1","shipment")
        new_shipment=stock.create_shipment(self.conn,"S1","shipment")
        legacy.add_shipment_line(self.sqlite,old_shipment["shipment_id"],before["reservation_id"],3,"line")
        stock.add_shipment_line(self.conn,new_shipment["shipment_id"],after["reservation_id"],3,"line")
        legacy.dispatch(self.sqlite,old_shipment["shipment_id"],"Carrier","dispatch","2026-10-27",tracking_ref="T1")
        stock.dispatch(self.conn,new_shipment["shipment_id"],"Carrier","dispatch","2026-10-27",tracking_ref="T1")
        self.assertEqual(self.levels(),(2,0,2))
        self.assertEqual(legacy.shipment(self.sqlite,old_shipment["shipment_id"])["status"],stock.shipment(self.conn,new_shipment["shipment_id"])["status"])
        legacy.record_tracking_event(self.sqlite,old_shipment["shipment_id"],"delivered","2026-10-27T12:00:00Z","event")
        stock.record_tracking_event(self.conn,new_shipment["shipment_id"],"delivered","2026-10-27T12:00:00Z","event")
        self.assertEqual(legacy.shipment(self.sqlite,old_shipment["shipment_id"])["status"],stock.shipment(self.conn,new_shipment["shipment_id"])["status"])
        self.levels()
