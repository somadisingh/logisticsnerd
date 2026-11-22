import { describe, it, expect } from 'vitest';
import { normalizeEasyPost, normalizeSmklog, normalizeAfterShip, runProvider } from '../server/shipping.mjs';
const p = { product:'Test parcel',fromPostal:'07102',toPostal:'30303',lengthCm:10,widthCm:10,heightCm:10,weightKg:1,pickupTime:'2026-11-23T10:00',deadline:'2026-11-25',carrier:'ups' };
const r = {id:'rate_one',carrier:'UPS',service:'Ground',rate:'10.00',currency:'USD'};
const pred = (id='rate_one',date='2026-11-24') => ({rate:{id},easypost_time_in_transit_data:{planned_ship_date:'2026-11-23',easypost_estimated_delivery_date:date}});
const env = {EASYPOST_TEST_API_KEY:'fixture',SMKLOG_ENABLED:'true',AFTERSHIP_API_KEY:'fixture',AFTERSHIP_EDD_ENABLED:'true'};
const json = body => new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
describe('untrusted shipping response integrity',()=>{
 it('does not match missing shipment and prediction rate IDs',()=>{expect(normalizeEasyPost({rates:[{...r,id:undefined}]},{rates:[{easypost_time_in_transit_data:pred().easypost_time_in_transit_data}]},p)[0].deliveryDate).toBeNull();});
 it('does not match blank IDs',()=>{expect(normalizeEasyPost({rates:[{...r,id:''}]},{rates:[pred('')]},p)[0].deliveryDate).toBeNull();});
 it('does not choose the first conflicting duplicate prediction',()=>{expect(normalizeEasyPost({rates:[r]},{rates:[pred(),pred('rate_one','2026-11-29')]},p)[0].deliveryDate).toBeNull();});
 it('does not match duplicate shipment rate IDs',()=>{expect(normalizeEasyPost({rates:[r,{...r,service:'Other'}]},{rates:[pred()]},p).every(x=>x.deliveryDate===null)).toBe(true);});
 it('preserves the price if prediction rates is not an array',()=>{expect(normalizeEasyPost({rates:[r]},{rates:{}},p)[0].costCents).toBe(1000);});
 it('ignores null prediction records',()=>{expect(normalizeEasyPost({rates:[r]},{rates:[null,pred()]},p)[0].deliveryDate).toBe('2026-11-24');});
 it('keeps a unique exact matching prediction',()=>{expect(normalizeEasyPost({rates:[r]},{rates:[pred('unrelated'),pred()]},p)[0].deliveryDate).toBe('2026-11-24');});
 for(const invalid of [null,4,'bad',[]]) {
  it(`rejects malformed SMKlog record ${JSON.stringify(invalid)}`,()=>expect(()=>normalizeSmklog({rates:[invalid]},p)).toThrow());
  it(`rejects malformed EasyPost record ${JSON.stringify(invalid)}`,()=>expect(()=>normalizeEasyPost({rates:[invalid]},null,p)).toThrow());
 }
 for(const value of [-1,-0.5,Infinity]) {
  it(`does not report negative/nonfinite transit days ${value}`,()=>{expect(normalizeSmklog({rates:[{delivery_days:value}]},p)[0].transitDays).toBeNull();expect(normalizeEasyPost({rates:[{...r,est_delivery_days:value}]},null,p)[0].transitDays).toBeNull();});
 }
 it('keeps genuine zero transit days',()=>{expect(normalizeSmklog({rates:[{delivery_days:0}]},p)[0].transitDays).toBe(0);});
 it('never invents USD for a missing SMKlog currency',()=>{expect(normalizeSmklog({rates:[{amount:5}]},p)[0].currency).toBeNull();});
 it('normalizes a valid currency code',()=>{expect(normalizeSmklog({rates:[{amount:5,currency:' usd '}]},p)[0].currency).toBe('USD');});
 it('rejects malformed currency codes',()=>{expect(normalizeEasyPost({rates:[{...r,currency:'DOLLARS'}]},null,p)[0].currency).toBeNull();});
 it('does not treat a negative transit-only response as usable data',async()=>{const x=await runProvider('smklog',p,{env,fetcher:async()=>json({rates:[{delivery_days:-3}]})});expect(x.status).toBe('incomplete_data');});
 it('reports malformed records as invalid_response',async()=>{const x=await runProvider('smklog',p,{env,fetcher:async()=>json({rates:[3]})});expect(x.status).toBe('invalid_response');expect(x.rates).toEqual([]);});
 it('rejects an oversized response body',async()=>{const x=await runProvider('smklog',p,{env,fetcher:async()=>json({rates:[{amount:1}],padding:'x'.repeat(1048577)})});expect(x.status).toBe('invalid_response');});
 it('bounds malformed top-level objects',async()=>{const x=await runProvider('aftership',p,{env,fetcher:async()=>json([])});expect(x.status).toBe('invalid_response');});
 it('does not leak raw malicious provider values in validation errors',async()=>{const x=await runProvider('smklog',p,{env,fetcher:async()=>json({rates:['fixture-secret-value']})});expect(JSON.stringify(x)).not.toContain('fixture-secret-value');});
 it('rejects too many rate rows',()=>{expect(()=>normalizeSmklog({rates:Array.from({length:1001},()=>({amount:1}))},p)).toThrow();});
});
