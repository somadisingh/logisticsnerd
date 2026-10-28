"""Checksum-verified, atomic migrations; explicit business identity initialization."""
from __future__ import annotations
import argparse
import hashlib
from pathlib import Path
import os

from .db import connect, verify_business
from .errors import ConfigurationError

MIGRATIONS = Path(__file__).resolve().parents[1] / 'supabase' / 'migrations'


def initialize_database(dsn: str, business_key: str, *, migrations: Path = MIGRATIONS) -> list[str]:
    if not business_key or not business_key.strip():
        raise ConfigurationError('A business identity is required')
    applied = []
    with connect(dsn) as conn:
        with conn.transaction():
            conn.execute('SELECT pg_advisory_xact_lock(1768842362,1)')
            if conn.execute("SELECT to_regclass('logistics.database_identity') AS name").fetchone()['name'] is not None:
                verify_business(conn,business_key)
            conn.execute('CREATE SCHEMA IF NOT EXISTS logistics')
            conn.execute('''CREATE TABLE IF NOT EXISTS logistics.schema_migrations(
                version text PRIMARY KEY, checksum text NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT now())''')
            rows = conn.execute('SELECT version,checksum FROM logistics.schema_migrations').fetchall()
            history = {r['version']: r['checksum'] for r in rows}
            files = sorted(migrations.glob('*.sql'))
            available = {p.name for p in files}
            if set(history) - available:
                raise ConfigurationError('Database migration history contains unavailable files')
            for path in files:
                contents = path.read_bytes()
                checksum = hashlib.sha256(contents).hexdigest()
                if path.name in history:
                    if history[path.name] != checksum:
                        raise ConfigurationError('Applied migration checksum does not match its source')
                    continue
                conn.execute(contents.decode('utf-8'), prepare=False)
                conn.execute('INSERT INTO logistics.schema_migrations(version,checksum) VALUES(%s,%s)',
                             (path.name, checksum))
                applied.append(path.name)
            # Never reassign an existing private database to another business.
            row = conn.execute('SELECT business_key FROM logistics.database_identity WHERE singleton=true').fetchone()
            if row is None:
                conn.execute('INSERT INTO logistics.database_identity(singleton,business_key) VALUES(true,%s)', (business_key,))
            verify_business(conn, business_key)
    return applied


def main():
    from dotenv import load_dotenv
    load_dotenv('.env.local', override=False)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--business', default=os.getenv('LOGISTICS_BUSINESS_KEY'))
    parser.add_argument('--backup-dir',default='.local-planning/backups')
    args = parser.parse_args()
    try:
        from .backup import backup_database
        backup=backup_database(os.getenv('LOGISTICS_DATABASE_URL',''),args.backup_dir)
        applied = initialize_database(os.getenv('LOGISTICS_DATABASE_URL',''), args.business)
    except Exception:
        # Connection exceptions can include credentials; CLI prints only safe text.
        raise SystemExit('Migration failed. Check connection, business identity, and migration history. No credentials displayed.')
    print(f'Migrations applied: {len(applied)}; business identity verified. Private business-schema backup saved locally.')

if __name__ == '__main__':
    main()
