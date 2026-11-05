"""Disposable real-database browser acceptance checks. Install playwright and its Chromium first.
Uses only synthetic local fixtures; never a hosted account or real model.
"""
import os,sys,tempfile,subprocess,time,json,socket
from pathlib import Path
from playwright.sync_api import sync_playwright
REPO=Path(__file__).resolve().parents[1]; PY=sys.executable; OUT=Path(os.environ.get('BROWSER_EVIDENCE_DIR', str(Path(__file__).resolve().parents[1]/'.browser-evidence')));OUT.mkdir(exist_ok=True)

def wait(url):
 import urllib.request
 for _ in range(120):
  try:
   with urllib.request.urlopen(url,timeout=1) as r: return
  except Exception: time.sleep(.1)
 raise RuntimeError('server did not start '+url)

def logistics():
 import pgserver,psycopg,fasteners,atexit
 from pgserver.postgres_server import PostgresServer
 sys.path.insert(0,str(REPO))
 from logistics_persistence.migrate import initialize_database
 from logistics_persistence.db import connect
 from logistics_persistence import stock
 from logistics_persistence.core import bind_reference
 with tempfile.TemporaryDirectory(prefix='nyu-feature-pg-') as temp:
  PostgresServer._lock=fasteners.InterProcessLock(temp+'/.lock');server=pgserver.get_server(Path(temp)/'data',cleanup_mode='stop')
  with psycopg.connect(server.get_uri(),autocommit=True) as c:c.execute('CREATE DATABASE logistics_test_browser')
  dsn=server.get_uri('logistics_test_browser');initialize_database(dsn,'browser-fixture')
  with connect(dsn,'browser-fixture') as conn:
   def bind(k,n):return bind_reference(conn,k,n,{'name':n},'bind-'+k+n)['id']
   item=bind('item','Synthetic toy truck');loc=bind('location','Main store');loc2=bind('location','Second store');stock.track_lots(conn,item,'track')
   for lot,exp,qty,l in [('old','2026-11-04',3,loc),('soon','2026-11-10',8,loc),('held','2026-11-03',5,loc),('<img src=x onerror=alert(1)>','2026-11-06',2,loc2)]:
    r=stock.receive(conn,item,qty,lot,'receive-'+lot,lot_number=lot,expiry_date=exp,location_id=l)
    if lot=='held':stock.hold_lot(conn,r['lot_id'],'check','hold')
   before=conn.execute('SELECT count(*) n FROM logistics.command_requests').fetchone()['n']
  env={**os.environ,'LOGISTICS_DATABASE_URL':dsn,'LOGISTICS_BUSINESS_KEY':'browser-fixture','LOGISTICS_API_TOKEN':'local-synthetic-token','LOGISTICS_ACTOR_REF':'fixture'}
  logs=[open(OUT/'logistics-server.log','w'),open(OUT/'vite-server.log','w')]
  ps=[subprocess.Popen([PY,'-m','uvicorn','logistics_persistence.api:app','--host','127.0.0.1','--port','8001'],cwd=REPO,env=env,stdout=logs[0],stderr=logs[0]),subprocess.Popen(['node',str(REPO/'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','5173','--strictPort'],cwd=REPO,env=env,stdout=logs[1],stderr=logs[1])]
  try:
   wait('http://127.0.0.1:5173/inventory.html');time.sleep(.3)
   checks=[]
   with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':950});page.goto('http://127.0.0.1:5173/inventory.html');page.get_by_text('Current stock loaded.',exact=False).wait_for()
    page.locator('[name=as_of]').fill('2026-11-05');page.get_by_role('button',name='Review current stock').click();page.get_by_text('Held: 5 units · Expired: 3 units · Expiring soon: 10 units',exact=True).wait_for();checks.append('real-PG held/expired/expiring totals')
    assert page.locator('#risk-result tbody tr').count()==4;checks.append('four distinct positive lot rows')
    assert page.locator('#risk-result img').count()==0;checks.append('hostile lot text escaped')
    page.screenshot(path=str(OUT/'logistics-inventory-desktop.png'),full_page=True)
    page.locator('[name=location_id]').select_option(str(loc));page.get_by_role('button',name='Review current stock').click();page.get_by_text('Held: 5 units · Expired: 3 units · Expiring soon: 8 units',exact=True).wait_for();checks.append('location filtering')
    page.locator('[name=horizon_days]').fill('0');page.get_by_role('button',name='Review current stock').click();page.get_by_text('Held: 5 units · Expired: 3 units · Expiring soon: 0 units',exact=True).wait_for();checks.append('zero-day horizon')
    page.locator('[name=item_id]').select_option(str(item));page.get_by_role('button',name='Review current stock').click();page.get_by_text('Current stock loaded.',exact=False).wait_for();checks.append('explicit item filter')
    page.locator('[name=horizon_days]').fill('367');assert not page.locator('#risk-form').evaluate('(f)=>f.checkValidity()');checks.append('invalid horizon blocked')
    page.locator('[name=horizon_days]').fill('30');page.locator('[name=as_of]').fill('2026-01-01');page.get_by_role('button',name='Review current stock').click();page.get_by_text('Held: 5 units · Expired: 0 units · Expiring soon: 0 units',exact=True).wait_for();checks.append('classification date not historical balance')
    page.route('**/api/purchasing/lot-risks?**',lambda route:route.fulfill(status=503,json={'error':{'message':'Synthetic outage'}}));page.get_by_role('button',name='Review current stock').click();page.get_by_text('Synthetic outage',exact=True).wait_for();assert page.locator('#risk-result').is_hidden();checks.append('failed refresh hides old totals')
    page.unroute('**/api/purchasing/lot-risks?**');
    page.route('**/api/purchasing/lot-risks?**',lambda route:route.fulfill(status=422,json={'detail':[{'loc':['query','as_of'],'msg':'Invalid date'}]}));page.get_by_role('button',name='Review current stock').click();page.get_by_text('as_of: Invalid date',exact=True).wait_for();checks.append('validation detail is readable');page.unroute('**/api/purchasing/lot-risks?**');page.locator('[name=as_of]').fill('2026-11-05');page.get_by_role('button',name='Review current stock').click();page.get_by_text('Current stock loaded.',exact=False).wait_for();checks.append('retry recovers real data')
    page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(OUT/'logistics-inventory-mobile.png'),full_page=True);assert page.evaluate('document.documentElement.scrollWidth <= innerWidth');checks.append('mobile no page overflow')
    assert not page.locator('input[type=password]').count();checks.append('no browser credential field')
    browser.close()
   with connect(dsn,'browser-fixture') as conn:assert conn.execute('SELECT count(*) n FROM logistics.command_requests').fetchone()['n']==before
   checks.append('all UI reads leave real command registry unchanged')
   (OUT/'logistics-browser-checks.json').write_text(json.dumps(checks,indent=2));print('Logistics browser: '+str(len(checks))+' checks passed',flush=True)
  finally:
   for p in ps:p.terminate()
   for p in ps:p.wait()
   for l in logs:l.close()
   server._cleanup();atexit.unregister(server._cleanup)


if __name__=='__main__': logistics()
