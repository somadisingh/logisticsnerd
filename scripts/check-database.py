#!/usr/bin/env python3
"""Read-only connection check. Never prints a DSN, password, or provider error."""
from pathlib import Path
import os
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv
load_dotenv('.env.local',override=False)
from logistics_persistence.db import connect


def main():
    dsn=os.getenv('LOGISTICS_DATABASE_URL','')
    if not dsn.strip():
        print('LOGISTICS_DATABASE_URL is blank. Save the session-pooler URI in .env.local.')
        return 1
    if '[YOUR-PASSWORD]' in dsn:
        print('Replace the password placeholder locally before connecting.')
        return 1
    try:
        with connect(dsn) as conn:
            row=conn.execute("SELECT current_database() AS database, current_setting('server_version') AS version, EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='logistics') AS logistics_exists").fetchone()
            count=conn.execute("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'").fetchone()['n']
    except Exception as error:
        print(f'Connection check failed ({type(error).__name__}). No connection details displayed.')
        return 1
    print(f"Connected to PostgreSQL {row['version']}; public tables: {count}; logistics schema exists: {row['logistics_exists']}.")
    print('Read-only check complete. No migrations applied.')
    return 0

if __name__=='__main__':
    raise SystemExit(main())
