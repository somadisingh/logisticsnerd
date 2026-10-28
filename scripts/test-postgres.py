#!/usr/bin/env python3
"""Run acceptance tests on a disposable native PostgreSQL server, without Docker."""
from pathlib import Path
import argparse
import os
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('-p','--pattern',default='test_*.py')
    args=parser.parse_args()
    try:
        import pgserver
        import psycopg
    except ImportError:
        raise SystemExit('Install requirements-purchasing-dev.txt into .venv first.')
    with tempfile.TemporaryDirectory(prefix='logistics-pg-',dir='/tmp') as directory:
        from pgserver.postgres_server import PostgresServer
        import fasteners
        PostgresServer._lock=fasteners.InterProcessLock(str(Path(directory)/'.server.lock'))
        server=pgserver.get_server(Path(directory)/'data',cleanup_mode='stop')
        with psycopg.connect(server.get_uri(),autocommit=True) as conn:
            conn.execute('CREATE DATABASE logistics_test')
        os.environ['LOGISTICS_TEST_DATABASE_URL']=server.get_uri('logistics_test')
        print('Running real PostgreSQL tests on an isolated local database.',flush=True)
        suite=unittest.defaultTestLoader.discover(str(ROOT/'tests_postgres'),pattern=args.pattern,top_level_dir=str(ROOT))
        result=unittest.TextTestRunner(verbosity=2).run(suite)
        server._cleanup()
        import atexit
        atexit.unregister(server._cleanup)
        return 0 if result.wasSuccessful() and result.testsRun else 1

if __name__=='__main__':
    raise SystemExit(main())
