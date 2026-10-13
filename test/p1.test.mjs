import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCard, x402Requirements, handleA2A } from '../src/autonomy/p1.js';

test('A2A agent card exposes bounded ATLAS capability',()=>{const c=agentCard('https://atlas.example');assert.equal(c.name,'ATLAS');assert.equal(c.provider.organization,'ATLAS');assert.equal(c.provider.url,'https://atlas.example');assert.match(c.description,/CSV\/XLSX data QA capability/i);const dataSkill=c.skills.find(s=>s.id==='data_qa');assert.ok(dataSkill.tags.includes('data-cleaning'));assert.ok(dataSkill.tags.includes('data-validation'));assert.ok(dataSkill.examples.length>=2);assert.deepEqual(c.securitySchemes,{});assert.deepEqual(c.securityRequirements,[]);assert.equal(c.capabilities.pushNotifications,false);assert.ok(c.skills.some(s=>s.id==='data_qa'));assert.equal(c.supportedInterfaces[0].url,'https://atlas.example/a2a');assert.equal(c.supportedInterfaces[0].protocolBinding,'JSONRPC');assert.equal(c.supportedInterfaces[0].protocolVersion,'1.0');const ext=c.capabilities.extensions.find(e=>e.uri==='https://a2a-registry.org/extensions/registry/v1');assert.ok(ext);assert.equal(ext.required,false);assert.equal(ext.params.identity.provider,'github');assert.equal(ext.params.identity.username,'hosamhosaam5-ops');assert.equal(ext.params.identity.packageName,'github.hosamhosaam5-ops.atlas');const commerce=c.capabilities.extensions.find(e=>e.uri==='https://atlas.example/extensions/commerce/v1');assert.ok(commerce);assert.equal(commerce.params.x402Settlement,'IMPLEMENTED_UNVERIFIED');});

test('A2A message/send fails closed and does not create a pending task',async()=>{
  const statements=[];
  const env={DB:{prepare(sql){statements.push(String(sql));throw new Error('DB must not be touched for rejected A2A work');}}};
  const id='a2a-no-task-regression';
  const request=new Request('https://atlas.example/a2a',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id,method:'message/send',params:{message:{messageId:id+'-message',role:'user',parts:[{kind:'text',text:'Please process a file.'}]}}})
  });
  const response=await handleA2A(request,env);
  assert.equal(response.status,400);
  assert.match(response.headers.get('content-type')||'',/application\\/json/i);
  const body=await response.json();
  assert.equal(body.jsonrpc,'2.0');
  assert.equal(body.id,id);
  assert.equal(body.error.code,-32001);
  assert.match(body.error.message,/No task was created/i);
  assert.match(body.error.message,/x402/);
  assert.match(body.error.message,/atlas_ai_data_qa_v1/);
  assert.equal(statements.length,0);
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
