from datetime import datetime,timedelta,timezone
from pathlib import Path
import tempfile
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from logistics_persistence import core,db,purchasing
from logistics_persistence.backup import backup_database,restore_into_empty_database
from logistics_persistence.errors import Conflict,ValidationError
from logistics_persistence.migrate import initialize_database
from logistics_persistence.seed import seed_demo
from .common import PostgresCase


class LifecycleTests(PostgresCase):
    def other_database(self):
        name='logistics_test_'+uuid4().hex
        self.conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        return name,make_conninfo(self.dsn,dbname=name)

    def remove_database(self,name):
        self.conn.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))

    def test_two_private_databases_have_independent_request_keys_and_ids(self):
        name,other=self.other_database()
        try:
            initialize_database(other,'second-business')
            with db.connect(other,'second-business') as c:
                one=db.run_command(self.conn,'isolation','same-key',{},lambda tx:{'value':'first'})
                two=db.run_command(c,'isolation','same-key',{},lambda tx:{'value':'second'})
                self.assertNotEqual(one,two)
                self.assertEqual(db.run_command(c,'isolation','same-key',{},lambda tx:self.fail()),two)
        finally:
            self.remove_database(name)

    def test_explicit_seed_replays_and_comparison_uses_uncovered_eleven(self):
        first=seed_demo(self.conn)
        self.assertEqual(seed_demo(self.conn),first)
        from logistics_persistence import stock
        self.assertEqual(stock.stock_summary(self.conn,first['item_id'],first['location_id'])['on_hand'],4)
        result=purchasing.compare_suppliers(self.conn,demand_line_id=first['demand_line_id'])
        self.assertEqual(result['quantity_to_purchase'],11)
        self.assertTrue(result['feasible'])
        self.assertEqual(self.conn.execute('SELECT count(*) AS n FROM purchase_orders').fetchone()['n'],0)

    def test_future_revision_and_destructive_history_are_rejected(self):
        ref=self.bind('supplier','supplier',{'address':'Original'})
        with self.assertRaises(ValidationError):
            core.bind_reference(self.conn,'supplier','supplier',{'address':'Future'},'future',effective_at=datetime.now(timezone.utc)+timedelta(days=1))
        with self.assertRaises(psycopg.Error):
            self.conn.execute("UPDATE core_bindings SET snapshot='{}' WHERE id=%s",(ref,))
        with self.assertRaises(psycopg.Error):
            self.conn.execute("UPDATE database_identity SET business_key='other'")
        with self.assertRaises(psycopg.Error):
            self.conn.execute("INSERT INTO core_bindings(kind,external_key,valid_from) VALUES('supplier','supplier',now())")

    def test_backup_restores_business_history_and_refuses_occupied_destination(self):
        item=self.bind('item','persistent-item')
        db.run_command(self.conn,'saved','replay-after-restore',{},lambda c:{'item_id':item})
        name,other=self.other_database()
        try:
            with tempfile.TemporaryDirectory() as directory:
                archive=backup_database(self.dsn,directory)
                self.assertTrue(archive.stat().st_size>0)
                self.assertEqual(archive.stat().st_mode&0o777,0o600)
                restore_into_empty_database(other,archive)
                with db.connect(other,'test-business') as restored:
                    self.assertEqual(restored.execute('SELECT external_key FROM core_bindings WHERE id=%s',(item,)).fetchone()['external_key'],'persistent-item')
                    self.assertEqual(db.run_command(restored,'saved','replay-after-restore',{},lambda c:self.fail()),{'item_id':item})
                with self.assertRaises(Conflict):
                    restore_into_empty_database(other,archive)
        finally:
            self.remove_database(name)
