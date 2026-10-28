"""Explicit, repeatable synthetic development fixtures; never core onboarding."""
import argparse
from datetime import date,datetime,timedelta,timezone
import os

from . import core,purchasing,stock
from .db import connect,run_command


def seed_demo(conn, actor_ref='soma'):
    anchor=run_command(conn,'demo.fixture','demo-v1:anchor',{'version':1,'actor_ref':actor_ref},
                       lambda c:{'anchor':datetime.now(timezone.utc).isoformat()})
    when=datetime.fromisoformat(anchor['anchor'])
    def binding(kind,key,snapshot):
        return core.bind_reference(conn,kind,key,{'fixture':True,**snapshot},
                                   f'demo-v1:binding:{kind}:{key}',effective_at=when)['id']
    item=binding('item','demo:chair',{'name':'Demo chair','unit':'each'})
    location=binding('location','demo:warehouse',{'name':'Demo warehouse'})
    actor=binding('actor',actor_ref,{'name':'Development owner','can_approve_purchases':True})
    suppliers=[binding('supplier',f'demo:supplier-{letter}',{'name':f'Demo supplier {letter}','address':f'{letter} Example Street'}) for letter in ('A','B')]
    binding('customer','demo:customer',{'name':'Demo customer'})
    binding('carrier','demo:carrier',{'name':'Manual demonstration carrier'})
    demand=core.register_demand(conn,external_key='demo:chair-line',order_ref='demo:customer-order',
        item_id=item,quantity=15,currency='USD',required_by=when.date()+timedelta(days=30),
        budget_minor=20000,idempotency_key='demo-v1:demand')['id']
    stock.open_stock(conn,item,4,'demo:opening','demo-v1:opening',location_id=location)
    stock.reserve(conn,item,4,'demo:chair-line','demo-v1:reserve',location_id=location,demand_line_id=demand)
    quotes=[]
    for supplier,quantity,price,letter in zip(suppliers,(11,11),(1000,1100),('A','B')):
        quotes.append(purchasing.create_quote(conn,supplier_id=supplier,item_id=item,quantity_priced=quantity,
            capacity_quantity=quantity,price_minor=price,pricing_kind='unit',currency='USD',
            expires_at=when+timedelta(days=14),expected_date=when.date()+timedelta(days=2),
            quote_ref=f'demo:offer-{letter}',source='supplier',generated_at=when,
            idempotency_key=f'demo-v1:quote:{letter}')['id'])
    return {'fixture':True,'item_id':item,'location_id':location,'actor_id':actor,
            'supplier_ids':suppliers,'demand_line_id':demand,'quote_version_ids':quotes}


def main():
    from dotenv import load_dotenv
    load_dotenv('.env.local',override=False)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--demo',action='store_true',required=True,help='Explicitly seed synthetic development records')
    args=parser.parse_args()
    try:
        with connect(os.getenv('LOGISTICS_DATABASE_URL',''),os.getenv('LOGISTICS_BUSINESS_KEY','')) as conn:
            result=seed_demo(conn,os.getenv('LOGISTICS_ACTOR_REF','soma'))
    except Exception:
        raise SystemExit('Demo seed failed. Verify migration, identity, and fixture state. No credentials displayed.')
    print('Synthetic development fixtures ready; OperationsNerd mapping remains pending.')
    print(f"Item {result['item_id']}, demand {result['demand_line_id']}, location {result['location_id']}; 4 reserved chairs, shortage 11.")

if __name__=='__main__':
    main()
