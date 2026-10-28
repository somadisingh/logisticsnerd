"""Private business-schema exports and restoration into an empty database."""
from datetime import datetime,timezone
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess

from psycopg.conninfo import conninfo_to_dict
from .db import connect
from .errors import ConfigurationError,Conflict


def _client(name,major):
    candidates=[]
    configured=os.getenv('LOGISTICS_'+name.upper())
    if configured: candidates.append(configured)
    if importlib.util.find_spec('pgserver'):
        import pgserver._commands
        candidates.append(str(pgserver._commands.POSTGRES_BIN_PATH/name))
    candidates.extend(filter(None,[shutil.which(name),f'/opt/homebrew/opt/libpq/bin/{name}']))
    supported=[]
    for candidate in dict.fromkeys(candidates):
        if not Path(candidate).is_file(): continue
        check=subprocess.run([candidate,'--version'],capture_output=True,text=True)
        match=re.search(r'PostgreSQL\)\s+(\d+)',check.stdout)
        if check.returncode==0 and match and int(match.group(1))>=major:
            supported.append((int(match.group(1)),candidate))
    if not supported: raise ConfigurationError(f'Install a {name} client matching or newer than the database server')
    return min(supported)[1]


def _environment(dsn):
    details=conninfo_to_dict(dsn)
    env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
    names={'dbname':'PGDATABASE','host':'PGHOST','hostaddr':'PGHOSTADDR','port':'PGPORT','user':'PGUSER',
           'password':'PGPASSWORD','sslmode':'PGSSLMODE','sslrootcert':'PGSSLROOTCERT','options':'PGOPTIONS'}
    for key,name in names.items():
        if key in details: env[name]=details[key]
    if details.get('host','').endswith(('.supabase.com','.supabase.co')) and 'sslmode' not in details:
        env['PGSSLMODE']='require'
    env['PGCONNECT_TIMEOUT']='10'
    return env


def backup_database(dsn,directory):
    with connect(dsn) as conn:
        major=int(conn.execute("SELECT current_setting('server_version_num') AS v").fetchone()['v'])//10000
    output=Path(directory)
    output.mkdir(parents=True,exist_ok=True)
    path=output/('business-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.dump')
    fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    os.close(fd)
    result=subprocess.run([_client('pg_dump',major),'--format=custom','--no-owner','--no-acl',
        '--schema=public','--schema=logistics','--file',str(path)],env=_environment(dsn),capture_output=True)
    if result.returncode:
        path.unlink(missing_ok=True)
        raise ConfigurationError('Business-schema backup failed; migration was not started')
    return path


def restore_into_empty_database(dsn,archive):
    """Refuse to overwrite either an existing business schema or public tables."""
    with connect(dsn) as conn:
        occupied=conn.execute("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='logistics') OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') AS occupied").fetchone()['occupied']
        if occupied: raise Conflict('Restore requires an empty destination database')
        major=int(conn.execute("SELECT current_setting('server_version_num') AS v").fetchone()['v'])//10000
    env=_environment(dsn)
    result=subprocess.run([_client('pg_restore',major),'--no-owner','--no-acl','--clean','--if-exists','--single-transaction','--exit-on-error',
                           '--dbname',env.get('PGDATABASE','postgres'),str(archive)],env=env,capture_output=True)
    if result.returncode: raise ConfigurationError('Restore failed; no archive details displayed')
