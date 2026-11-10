// Offline contracts only. No carrier accounts, paid requests or live-quality claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAfterShip, normalizeEasyPost, runProvider, createComparisonRunner } from '../server/shipping.mjs';
const p = { product:'Stationery', fromPostal:'07102',toPostal:'30303', lengthCm:30,widthCm:20,heightCm:10,weightKg:1,pickupTime:'2026-11-10T10:00',deadline:'2026-11-12',carrier:'ups' };
const row = (data) => normalizeAfterShip({data}, p)[0];
const cases = [
 ['point before pickup',{estimated_delivery_date:'2026-11-09'}],
 ['window before pickup',{estimated_delivery_date_min:'2026-11-07',estimated_delivery_date_max:'2026-11-09'}],
 ['window starts before pickup',{estimated_delivery_date_min:'2026-11-09',estimated_delivery_date_max:'2026-11-12'}],
 ['latest alone before pickup',{estimated_delivery_date_max:'2026-11-09'}],
 ['invalid late-window start',{estimated_delivery_date_min:'2026-11-09',estimated_delivery_date_max:'2026-11-16'}],
 ['point before pickup with otherwise valid window',{estimated_delivery_date:'2026-11-09',estimated_delivery_date_min:'2026-11-11',estimated_delivery_date_max:'2026-11-12'}],
 ['reversed window',{estimated_delivery_date_min:'2026-11-16',estimated_delivery_date_max:'2026-11-11'}],
];
for (const [name,data] of cases) test(`unknown for ${name}`, () => assert.equal(row(data).deadlineAssessment,'unknown'));
for (const [name,data,want] of [
 ['point on deadline',{estimated_delivery_date:'2026-11-12'},'estimated_on_time'],
 ['point on pickup',{estimated_delivery_date:'2026-11-10'},'estimated_on_time'],
 ['consistent late window',{estimated_delivery_date:'2026-11-15',estimated_delivery_date_min:'2026-11-14',estimated_delivery_date_max:'2026-11-16'},'estimated_late'],
 ['straddling window',{estimated_delivery_date:'2026-11-12',estimated_delivery_date_min:'2026-11-11',estimated_delivery_date_max:'2026-11-16'},'uncertain'],
 ['consistent on-time window',{estimated_delivery_date:'2026-11-11',estimated_delivery_date_min:'2026-11-10',estimated_delivery_date_max:'2026-11-12'},'estimated_on_time'],
 ['missing dates',{},'unknown'],
]) test(`preserves ${name}`,()=>assert.equal(row(data).deadlineAssessment,want));
test('EasyPost planned-date response before pickup is unknown; price survives',()=>{
 const result=normalizeEasyPost({rates:[{id:'r',rate:'10.23',currency:'USD'}]},{rates:[{rate:{id:'r'},easypost_time_in_transit_data:{planned_ship_date:'2026-11-10',easypost_estimated_delivery_date:'2026-11-09'}}]},p)[0];
 assert.equal(result.deadlineAssessment,'unknown');assert.equal(result.costCents,1023);assert.equal(result.deliveryDate,'2026-11-09');
});
const env={AFTERSHIP_API_KEY:'offline-fixture',AFTERSHIP_EDD_ENABLED:'true'};
const response=()=>new Response(JSON.stringify({data:cases[0][1]}),{status:200,headers:{'Content-Type':'application/json'}});
test('provider runner keeps contradictory dates visible without an on-time recommendation',async()=>{
 const r=await runProvider('aftership',p,{env,fetcher:async()=>response()});
 assert.equal(r.status,'ok');assert.equal(r.rates[0].deadlineAssessment,'unknown');assert.equal(r.rates[0].deliveryDate,'2026-11-09');assert.equal(r.traces.length,1);
});
test('comparison cache preserves unknown and does not make an extra request',async()=>{
 let calls=0;const run=createComparisonRunner({env,fetcher:async()=>{calls++;return response();}});
 const first=await run(p,['aftership']);const second=await run(p,['aftership']);
 assert.equal(calls,1);assert.equal(first.results[0].rates[0].deadlineAssessment,'unknown');assert.equal(second.results[0].rates[0].deadlineAssessment,'unknown');assert.equal(second.results[0].cached,true);
});
