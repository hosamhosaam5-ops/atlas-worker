import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCard, x402Requirements, handleA2A } from '../src/autonomy/p1.js';

test('A2A agent card exposes bounded ATLAS capability',()=>{const c=agentCard('https://atlas.example');assert.equal(c.name,'ATLAS');assert.equal(c.provider.organization,'ATLAS');assert.equal(c.provider.url,'https://atlas.example');assert.match(c.description,/CSV\/XLSX data QA capability/i);const dataSkill=c.skills.find(s=>s.id==='data_qa');assert.ok(dataSkill.tags.includes('data-cleaning'));assert.ok(dataSkill.tags.includes('data-validation'));assert.ok(dataSkill.examples.length>=2);assert.deepEqual(c.securitySchemes,{});assert.deepEqual(c.securityRequirements,[]);assert.equal(c.capabilities.pushNotifications,false);assert.ok(c.skills.some(s=>s.id==='data_qa'));assert.equal(c.supportedInterfaces[0].url,'https://atlas.example/a2a');assert.equal(c.supportedInterfaces[0].protocolBinding,'JSONRPC');assert.equal(c.supportedInterfaces[0].protocolVersion,'1.0');const ext=c.capabilities.extensions.find(e=>e.uri==='https://a2a-registry.org/extensions/registry/v1');assert.ok(ext);assert.equal(ext.required,false);assert.equal(ext.params.identity.provider,'github');assert.equal(ext.params.identity.username,'hosamhosaam5-ops');assert.equal(ext.params.identity.packageName,'github.hosamhosaam5-ops.atlas');const commerce=c.capabilities.extensions.find(e=>e.uri==='https://atlas.example/extensions/commerce/v1');assert.ok(commerce);assert.equal(commerce.params.x402Settlement,'IMPLEMENTED_UNVERIFIED');});

class FakeA2ADB {
  constructor(active=false){this.active=active;this.tasks=new Map();this.inserts=0;}
  prepare(sql){
    const db=this; let args=[];
    return {
      bind(...values){args=values;return this;},
      async run(){
        if(sql.includes('INSERT INTO agent_tasks')){
          db.inserts++;
          if(db.tasks.has(args[0])) return {meta:{changes:0}};
          db.tasks.set(args[0],{task_id:args[0],source:args[1],status:'PROCESSING',input_json:args[2],output_json:'{}'});
          return {meta:{changes:1}};
        }
        if(sql.includes('UPDATE agent_tasks')){
          const task=db.tasks.get(args[args.length-1]);
          if(task){if(sql.includes("status='REVIEW_REQUIRED'")){task.status='REVIEW_REQUIRED';task.output_json=args[0];}
            else {task.status=args[0];task.output_json=args[1];}}
          return {meta:{changes:task?1:0}};
        }
        return {meta:{changes:1}};
      },
      async first(){
        if(sql.includes('FROM products')) return db.active?{product_id:'atlas_ai_data_qa_v1',status:'ACTIVE',price_usdc:15}:null;
        if(sql.includes('FROM agent_tasks')) return db.tasks.get(args[0])||null;
        return null;
      }
    };
  }
}

test('A2A message/send fails closed while offer is paused and creates no task',async()=>{
  const db=new FakeA2ADB(false);
  const id='a2a-paused-regression';
  const response=await handleA2A(new Request('https://atlas.example/a2a',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method:'message/send',params:{message:{messageId:id+'-message',role:'user',parts:[{kind:'text',text:'Please process a file.'}]}}})}),{DB:db});
  assert.equal(response.status,400);
  const body=await response.json();
  assert.equal(body.jsonrpc,'2.0'); assert.equal(body.id,id); assert.equal(body.error.code,-32001);
  assert.match(body.error.message,/offer is paused/i); assert.match(body.error.message,/x402/);
  assert.equal(db.tasks.size,0); assert.equal(db.inserts,0);
});

test('A2A paid task delegates once to canonical x402 and persists result for retries',async()=>{
  const db=new FakeA2ADB(true); const id='a2a-paid-idempotency-1'; let delegated=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    delegated++;
    assert.equal(url,'https://atlas.example/x402/atlas_ai_data_qa_v1');
    assert.equal(init.headers['PAYMENT-SIGNATURE'],'opaque-facilitator-validated-payload');
    const payload=JSON.parse(init.body);
    assert.equal(payload.client_email,'agent@example.com'); assert.equal(payload.file_name,'sample.csv');
    return new Response(JSON.stringify({ok:true,order:{order_id:'X402-test',order_status:'DELIVERED',payment_status:'PAID',rows_in:2,rows_out:2,qa_report:'PASS'}}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    const request=()=>new Request('https://atlas.example/a2a',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'rpc-'+id,method:'message/send',params:{message:{messageId:id,role:'user',parts:[{kind:'text',text:'Run data QA'}],metadata:{atlas_x402:{client_email:'agent@example.com',file_name:'sample.csv',file_base64:'bmFtZSx2YWx1ZQphbHBoYSwxMA==',payment_signature:'opaque-facilitator-validated-payload'}}}}})});
    const first=await handleA2A(request(),{DB:db}); assert.equal(first.status,200);
    const result=(await first.json()).result; assert.equal(result.status.state,'completed'); assert.equal(result.artifacts[0].parts[0].data.order_status,'DELIVERED');
    const second=await handleA2A(request(),{DB:db}); assert.equal(second.status,200);
    const again=(await second.json()).result; assert.equal(again.status.state,'completed'); assert.equal(again.artifacts[0].parts[0].data.order_id,'X402-test');
    assert.equal(delegated,1); assert.equal(db.inserts,1);
    const get=await handleA2A(new Request('https://atlas.example/a2a',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'get-1',method:'tasks/get',params:{id}})}),{DB:db});
    assert.equal((await get.json()).result.artifacts[0].parts[0].data.order_status,'DELIVERED');
  } finally {globalThis.fetch=originalFetch;}
});

test('A2A paid task rejects missing payment and file metadata before task creation',async()=>{
  const db=new FakeA2ADB(true); const id='a2a-invalid-payment';
  const response=await handleA2A(new Request('https://atlas.example/a2a',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'rpc-invalid',method:'message/send',params:{message:{messageId:id,role:'user',parts:[{kind:'text',text:'Process'}]}}})}),{DB:db});
  assert.equal(response.status,400); const body=await response.json(); assert.equal(body.error.code,-32602);
  assert.equal(db.tasks.size,0); assert.equal(db.inserts,0);
});

test('A2A tasks/get returns not-found for an absent task',async()=>{
  const statements=[];
  const env={DB:{prepare(sql){statements.push(String(sql));return {bind(){return this;},async run(){return {success:true};},async first(){return null;}};}}};
  const request=new Request('https://atlas.example/a2a',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:'task-get-missing',method:'tasks/get',params:{id:'task_does_not_exist'}})
  });
  const response=await handleA2A(request,env);
  assert.equal(response.status,404);
  const body=await response.json();
  assert.equal(body.jsonrpc,'2.0');
  assert.equal(body.id,'task-get-missing');
  assert.equal(body.error.code,-32004);
  assert.match(body.error.message,/Task not found/i);
  assert.ok(statements.some(sql=>sql.includes('SELECT task_id,status,source FROM agent_tasks')));
});

test('x402 requirements are exact Base USDC payment requirements',()=>{const r=x402Requirements('https://atlas.example',{price_usdc:15,wallet:'0x1111111111111111111111111111111111111111',asset:'0x2222222222222222222222222222222222222222'});assert.equal(r.x402Version,2);assert.equal(r.accepts[0].scheme,'exact');assert.equal(r.accepts[0].network,'eip155:8453');assert.equal(r.accepts[0].amount,'15000000');});

