import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, trackReferral } from '../src/autonomy/p2.js';

test('P2 catalog exposes only active machine-readable products', async ()=>{
  const db={prepare(sql){ return {run:async()=>({}),all:async()=>({results:[
    {product_id:'atlas_ai_data_qa_v1',name:'AI Agent Data QA & Transformation',description:'Clean CSV/XLSX data.',unit:'dataset',price_usdc:15,pricing_mode:'FOUNDER_QUOTE',status:'ACTIVE',version:3}
  ]})}; }};
  const c=await buildCatalog(db,'https://atlas.example');
  assert.equal(c.products.length,1);
  assert.equal(c.products[0].status,'ACTIVE');
  assert.equal(c.discovery.agent_card,'https://atlas.example/.well-known/agent-card.json');
});

test('P2 referral tracking sanitizes and records bounded data', async ()=>{
  let bound;
  const db={prepare(){return {run:async()=>{bound=[...arguments];}}}};
  db.prepare=()=>({bind(...args){bound=args;return {run:async()=>({})}}});
  const r=await trackReferral(db,{code:'agent-souk',path:'/r/agent-souk',user_agent:'x'.repeat(1000),source:'https://example.test'});
  assert.equal(r.ok,true);
  assert.equal(bound[0],'agent-souk');
  assert.ok(String(bound[2]).length<=500);
});
