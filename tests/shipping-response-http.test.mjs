import { afterEach, it, expect, vi } from 'vitest';
import http from 'node:http';
import { shippingMiddleware } from '../server/middleware.mjs';
const p={product:'Test parcel',fromPostal:'07102',toPostal:'30303',lengthCm:10,widthCm:10,heightCm:10,weightKg:1,pickupTime:'2026-11-23T10:00',deadline:'2026-11-25',carrier:'ups'};
afterEach(()=>vi.unstubAllGlobals());
it.each([
 ['malformed rate',{rates:[null]},'invalid_response'],
 ['unknown currency',{rates:[{amount:1}]},'ok'],
 ['negative days',{rates:[{delivery_days:-1}]},'incomplete_data'],
])('actual local middleware rejects or qualifies %s',async(_,body,status)=>{
 const realFetch=globalThis.fetch;
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(body))));
 const mw=shippingMiddleware(()=>({SMKLOG_ENABLED:'true'}));
 const server=http.createServer((req,res)=>mw(req,res,()=>{res.writeHead(404);res.end();}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const url=`http://127.0.0.1:${server.address().port}/api/shipping/compare`;
  const response=await realFetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parcel:p,providers:['smklog']})});
  expect(response.status).toBe(200);const data=await response.json();expect(data.results[0].status).toBe(status);
  if(status==='invalid_response')expect(data.results[0].rates).toEqual([]);
  if(body.rates[0]?.amount)expect(data.results[0].rates[0].currency).toBeNull();
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
