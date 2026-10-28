"""Destructive fixtures restricted to explicitly configured local test databases."""
import os
import unittest
from datetime import date, timedelta
from itertools import count

from logistics_persistence.db import connect
from logistics_persistence.migrate import initialize_database
from logistics_persistence.core import bind_reference, register_demand


class PostgresCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dsn = os.environ.get('LOGISTICS_TEST_DATABASE_URL','')
        if not cls.dsn:
            raise unittest.SkipTest('Run scripts/test-postgres.py for a disposable PostgreSQL database')
        with connect(cls.dsn) as conn:
            info=conn.execute('SELECT current_database() AS name,inet_server_addr() AS address').fetchone()
            from psycopg.conninfo import conninfo_to_dict
            host=conninfo_to_dict(cls.dsn).get('host','')
            local=info['address'] is None or host in ('127.0.0.1','::1','localhost')
            if not info['name'].startswith('logistics_test') or not local:
                raise RuntimeError('Test resets are restricted to a local logistics_test database')
        initialize_database(cls.dsn,'test-business')

    def setUp(self):
        self.conn=connect(self.dsn,'test-business')
        from psycopg import sql
        # User-created physical tables are schema state, not just fixture rows.
        # Drop only registered tables inside the validated disposable database.
        if self.conn.execute("SELECT to_regclass('logistics.record_tables') AS name").fetchone()['name']:
            registered=self.conn.execute('SELECT slug FROM logistics.record_tables').fetchall()
            for row in registered:
                self.conn.execute(sql.SQL('DROP TABLE IF EXISTS {} CASCADE').format(
                    sql.Identifier('logistics','record_'+row['slug'])))
        tables=self.conn.execute("SELECT tablename FROM pg_tables WHERE schemaname='logistics' AND tablename NOT IN ('database_identity','schema_migrations')").fetchall()
        if tables:
            self.conn.execute(sql.SQL('TRUNCATE {} RESTART IDENTITY CASCADE').format(
                sql.SQL(',').join(sql.Identifier('logistics',r['tablename']) for r in tables)))
        self._keys=count(1)

    def tearDown(self):
        self.conn.close()

    def key(self,prefix='test'):
        return f'{prefix}-{next(self._keys)}'

    def newconn(self):
        return connect(self.dsn,'test-business')

    def bind(self,kind,key,snapshot=None):
        return bind_reference(self.conn,kind,key,snapshot or {'name':key},self.key('bind'))['id']

    def demand(self,item_id,quantity,order_ref='order-1',budget_minor=None,required_by=None):
        key=self.key('demand')
        return register_demand(self.conn,external_key=key,order_ref=order_ref,item_id=item_id,
            quantity=quantity,currency='USD',required_by=required_by or date.today()+timedelta(days=30),
            budget_minor=budget_minor,idempotency_key=key)['id']

DatabaseTestCase=PostgresCase
