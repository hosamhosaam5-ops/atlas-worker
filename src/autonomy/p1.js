async function ensureP1Schema(db){await db.prepare(`CREATE TABLE IF NOT EXISTS agent_webhooks (webhook_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,url TEXT NOT NULL,events_json TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'ACTIVE',created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT)`).run();await db.prepare(`CREATE TABLE IF NOT EXISTS agent_tasks (task_id TEXT PRIMARY KEY,source TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'SUBMITTED',input_json TEXT NOT NULL DEFAULT '{}',output_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT)`).run();await db.prepare('CREATE INDEX IF NOT EXISTS idx_agent_webhooks_agent ON agent_webhooks(agent_id,status)').run();await db.prepare('CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status,created_at)').run();await db.prepare(`CREATE TABLE IF NOT EXISTS customer_events (id INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT NOT NULL,entity_id TEXT,payload_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')))` ).run();}
import { checkBudget, registerCapability } from './registry.js';
import { sanitizeExternalInput, validateMarketplaceLead, authorizeAction } from './policy.js';
const clean=v=>sanitizeExternalInput(v).data;
export function agentCard(origin){return {name:'ATLAS',description:'Machine-readable CSV/XLSX data QA capability discovery for AI agents. Paid A2A task submissions require x402 payment metadata and delegate to the canonical paid resource; unpaid task submissions are not accepted.',version:'1.0.0',provider:{organization:'ATLAS',url:origin},securitySchemes:{},securityRequirements:[],supportedInterfaces:[{url:origin+'/a2a',protocolBinding:'JSONRPC',protocolVersion:'1.0'}],capabilities:{streaming:false,pushNotifications:false,extensions:[{uri:'https://a2a-registry.org/extensions/registry/v1',description:'A2A Registry identity and payment discovery metadata',required:false,params:{identity:{provider:'github',username:'hosamhosaam5-ops',packageName:'github.hosamhosaam5-ops.atlas'},payment:{model:'paid',protocols:['x402'],direction:'inbound',rails:[{network:'base',token:'USDC',type:'stablecoin',protocol:'x402',caip2:'eip155:8453',contractAddress:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'}]}}},{uri:origin+'/extensions/commerce/v1',description:'ATLAS machine-readable commerce lifecycle and payment safety metadata',required:false,params:{manifestUrl:origin+'/commerce.json',x402RequirementsUrl:origin+'/x402/atlas_ai_data_qa_v1',settlement:'BASE_RPC_INBOUND',x402Settlement:'IMPLEMENTED_UNVERIFIED'}}]},skills:[{id:'data_qa',name:'AI Agent Data QA & Transformation',description:'Paid CSV/XLSX data cleaning and quality checks up to 5,000 rows are available through the canonical x402 processing path. A2A message/send requires x402 payment metadata; completion is reported only after the paid pipeline confirms delivery.',tags:['csv','xlsx','data-quality','data-cleaning','data-validation','dataset-transformation','ai-agents','machine-readable'],examples:['Discover the published x402 data-QA resource and its exact payment requirements.','Read the data-QA API contract before submitting a paid dataset.'],inputModes:['application/json'],outputModes:['application/json','text/csv']}],defaultInputModes:['application/json'],defaultOutputModes:['application/json','text/csv'],documentationUrl:origin+'/llms.txt'};}
export async function createWebhook(db,{agent_id,url,events=['order.completed','order.failed']}={}){await ensureP1Schema(db);if(!agent_id||!/^https:\/\//i.test(String(url||'')))throw new Error('INVALID_WEBHOOK');const s=clean({agent_id,url,events});const id='wh_'+crypto.randomUUID().replaceAll('-','').slice(0,20);await db.prepare('INSERT INTO agent_webhooks(webhook_id,agent_id,url,events_json,status) VALUES(?,?,?,?,?)').bind(id,String(s.agent_id).slice(0,200),String(s.url).slice(0,2048),JSON.stringify(Array.isArray(s.events)?s.events.slice(0,20):[]),'ACTIVE').run();return {ok:true,webhook_id:id,status:'ACTIVE'};}
export async function listWebhooks(db,{agent_id}={}){await ensureP1Schema(db);const q=agent_id?await db.prepare('SELECT webhook_id,agent_id,url,events_json,status,created_at,updated_at FROM agent_webhooks WHERE agent_id=? ORDER BY created_at DESC LIMIT 50').bind(String(agent_id)).all():await db.prepare('SELECT webhook_id,agent_id,url,events_json,status,created_at,updated_at FROM agent_webhooks ORDER BY created_at DESC LIMIT 50').all();return q.results||[];}
export async function discoverAgentMarketplaces(db){const checks=[{id:'agent_souk',url:'https://api.agentsouk.dev/v1/listings',auth:false},{id:'agentgigs',url:'https://www.agentgigs.io/api/agent/jobs/available',auth:true},{id:'agent_job',url:'https://agent-job.ai/api-docs',auth:false}];const out=[];for(const s of checks){const b=await checkBudget(db,{external_requests:1});if(!b.allowed)return {ok:false,blocked:b.violations,results:out};try{const r=await fetch(s.url,{headers:{accept:'application/json,text/html'},signal:AbortSignal.timeout(8000)});const status=r.status===401||r.status===403?'AUTH_REQUIRED':r.ok?'AVAILABLE':'DEGRADED';out.push({id:s.id,status,http_status:r.status,auth_required:s.auth});await registerCapability(db,{capability_id:s.id,kind:'marketplace',provider:s.id,protocol:'API/MCP',endpoint:s.url,cost_class:'free',risk:'medium',status});}catch(e){out.push({id:s.id,status:'UNREACHABLE',error:String(e?.message||e)});}}return {ok:true,results:out};}
export async function prepareOffer(db,{signal_id,price_usdc,message}={}){await ensureP1Schema(db);const row=await db.prepare('SELECT id,source,request_summary,score,status FROM demand_signals WHERE id=?').bind(Number(signal_id)).first();if(!row)throw new Error('DEMAND_SIGNAL_NOT_FOUND');const safe=validateMarketplaceLead(clean({description:row.request_summary}));if(!safe.ok)throw new Error(safe.reason);const p=Math.max(15,Math.min(5000,Number(price_usdc||15)));const gate=authorizeAction('offer',{});if(!gate.allowed)throw new Error(gate.reason);const action_key='offer|'+row.id;await db.prepare("INSERT OR REPLACE INTO growth_actions(action_key,action_type,target_id,payload_json,status,risk,updated_at) VALUES(?,?,?,?,?,?,datetime('now'))").bind(action_key,'OFFER_READY',String(row.id),JSON.stringify({source:row.source,summary:row.request_summary,price_usdc:p,message:String(message||'ATLAS can fulfill this request within the approved scope.').slice(0,4000),requires_external_channel:true}),'READY','medium').run();return {ok:true,action_key,price_usdc:p,status:'READY',external_send:'NOT_ATTEMPTED'};}
export async function negotiateOffer(db,{action_key,counter_price_usdc}={}){await ensureP1Schema(db);const row=await db.prepare('SELECT * FROM growth_actions WHERE action_key=?').bind(String(action_key)).first();if(!row)throw new Error('OFFER_NOT_FOUND');const p=JSON.parse(row.payload_json||'{}');const current=Number(p.price_usdc||15),counter=Number(counter_price_usdc);if(!(counter>0)||counter<15||counter>5000)throw new Error('COUNTER_PRICE_OUT_OF_BOUNDS');const agreed=Number(((current+counter)/2).toFixed(2));p.negotiation={current_price_usdc:current,counter_price_usdc:counter,proposed_price_usdc:agreed,mode:'BOUNDED_MIDPOINT',founder_quote_required:true};await db.prepare("UPDATE growth_actions SET payload_json=?,status='NEGOTIATION_READY',updated_at=datetime('now') WHERE action_key=?").bind(JSON.stringify(p),String(action_key)).run();return {ok:true,action_key,proposed_price_usdc:agreed,founder_quote_required:true,external_send:'NOT_ATTEMPTED'};}
export async function productIntelligence(db){await ensureP1Schema(db);const demand=await db.prepare("SELECT source,COUNT(*) count,AVG(score) avg_score FROM demand_signals GROUP BY source ORDER BY count DESC").all();const products=await db.prepare("SELECT product_id,name,status,price_usdc FROM products ORDER BY updated_at DESC LIMIT 100").all();const orders=await db.prepare("SELECT product_id,COUNT(*) count,SUM(CASE WHEN status='DELIVERED' THEN 1 ELSE 0 END) delivered FROM order_ledger GROUP BY product_id").all();return {ok:true,demand:demand.results||[],products:products.results||[],orders:orders.results||[],recommendation:'REUSE_ACTIVE_PRODUCT_FIRST; BUILD_ONLY_AFTER_REPEATED_DEMAND'};}
export function x402Requirements(origin,{product_id='atlas_ai_data_qa_v1',price_usdc=15,wallet,asset,network='eip155:8453'}={}){return {x402Version:2,error:'PAYMENT-SIGNATURE header is required',resource:{url:origin+'/x402/'+encodeURIComponent(product_id),description:'ATLAS agent-native product access',mimeType:'application/json',serviceName:'ATLAS',tags:['data','qa','ai-agent']},accepts:[{scheme:'exact',network,amount:String(Math.round(Number(price_usdc)*1e6)),asset,payTo:wallet,maxTimeoutSeconds:300,extra:{name:'USDC',version:'2'}}],extensions:{}};}
export async function handleA2A(request,env){
  const origin=new URL(request.url).origin;
  const headers={'content-type':'application/json','cache-control':'no-store'};
  if(request.method==='GET')return new Response(JSON.stringify(agentCard(origin)),{headers});
  let msg;
  try{msg=await request.json();}catch{return new Response(JSON.stringify({jsonrpc:'2.0',error:{code:-32700,message:'Parse error'}}),{status:400,headers});}
  const id=msg?.id??null;
  if(msg?.jsonrpc!=='2.0'||!msg?.method)return new Response(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32600,message:'Invalid Request'}}),{status:400,headers});
  if(msg.method==='message/send'){
    const message=msg?.params?.message;
    const taskId=String(message?.messageId||'').trim();
    if(!taskId||taskId.length>200||message?.role!=='user'||!Array.isArray(message?.parts)){
      return new Response(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32602,message:'Invalid A2A message. Provide message.messageId, role=user, and parts.'}}),{status:400,headers});
    }
    // Initialize storage, then replay an existing task before checking current offer state.
    // A saved result remains retrievable after the offer is paused; replay never re-enters x402.
    await ensureP1Schema(env.DB);
    // New work is accepted only while the paid offer is explicitly active.
    const product=await env.DB.prepare("SELECT product_id,status,price_usdc FROM products WHERE product_id=?").bind("atlas_ai_data_qa_v1").first();
    if(!product||String(product.status)!=='ACTIVE'||Number(product.price_usdc)!==15){
      return new Response(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32001,message:'A2A paid task execution is unavailable while the offer is paused. No task was created. Discover the canonical x402 resource at '+origin+'/x402/atlas_ai_data_qa_v1; do not submit payment while it is paused.'}}),{status:400,headers});
    }
    const atlas=message?.metadata?.atlas_x402;
    const clientEmail=String(atlas?.client_email||'').trim();
    const fileName=String(atlas?.file_name||'').trim();
    const fileBase64=String(atlas?.file_base64||'').trim();
    const paymentSignature=String(atlas?.payment_signature||'').trim();
    if(!/^\S+@\S+\.\S+$/.test(clientEmail)||!fileName||!/^.+\.(csv|xlsx)$/i.test(fileName)||!fileBase64||fileBase64.length>1900000||!paymentSignature){
      return new Response(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32602,message:'Paid data-QA tasks require metadata.atlas_x402 with client_email, file_name (.csv/.xlsx), file_base64, and payment_signature. Payment is validated only by the canonical x402 resource.'}}),{status:400,headers});
    }
    const prior=await env.DB.prepare('SELECT task_id,status,output_json FROM agent_tasks WHERE task_id=?').bind(taskId).first();
    if(prior){
      let saved={};try{saved=JSON.parse(prior.output_json||'{}')}catch{}
      return new Response(JSON.stringify({jsonrpc:'2.0',id,result:{id:prior.task_id,status:{state:String(prior.status).toLowerCase()},...(Object.keys(saved).length?{artifacts:[{parts:[{kind:'data',data:saved}]}]}:{})}}),{headers});
    }
    const claimed=await env.DB.prepare("INSERT INTO agent_tasks(task_id,source,status,input_json,output_json) VALUES(?,?,'PROCESSING',?,'{}') ON CONFLICT(task_id) DO NOTHING")
      .bind(taskId,'a2a',JSON.stringify({product_id:'atlas_ai_data_qa_v1',file_name:fileName})).run();
    if(Number(claimed.meta?.changes||0)!==1){
      const current=await env.DB.prepare('SELECT task_id,status,output_json FROM agent_tasks WHERE task_id=?').bind(taskId).first();
      return new Response(JSON.stringify({jsonrpc:'2.0',id,result:{id:taskId,status:{state:String(current?.status||'processing').toLowerCase()}}}),{headers});
    }
    let responseBody={};
    let status='FAILED';
    try{
      // Delegate settlement, nonce protection, order ledger, QA, and delivery to the
      // exact production x402 handler. A2A never verifies or settles payment itself.
      const delegated=await fetch(origin+'/x402/atlas_ai_data_qa_v1',{
        method:'POST',
        headers:{'content-type':'application/json','PAYMENT-SIGNATURE':paymentSignature},
        body:JSON.stringify({client_email:clientEmail,file_name:fileName,file_base64:fileBase64}),
        signal:AbortSignal.timeout(65000)
      });
      try{responseBody=await delegated.json()}catch{responseBody={error:'INVALID_X402_RESPONSE'}}
      const order=responseBody?.order||{};
      if(delegated.ok&&responseBody?.ok===true&&order.order_status==='DELIVERED')status='COMPLETED';
      else if(responseBody?.payment||responseBody?.order?.order_status==='REVIEW_REQUIRED'||String(responseBody?.error||'').includes('SETTLEMENT_REVIEW'))status='REVIEW_REQUIRED';
      const resultData={
        order_id:order.order_id||null,
        order_status:order.order_status||responseBody?.error||'PROCESSING_FAILED',
        payment_status:order.payment_status||null,
        rows_in:order.rows_in??null,
        rows_out:order.rows_out??null,
        qa_report:order.qa_report||null,
        message:status==='COMPLETED'?'Paid data-QA processing and delivery completed.':status==='REVIEW_REQUIRED'?'Payment or order outcome requires reconciliation; do not retry payment.':'The canonical x402 handler did not confirm successful completion.'
      };
      await env.DB.prepare("UPDATE agent_tasks SET status=?,output_json=?,updated_at=datetime('now') WHERE task_id=? AND status='PROCESSING'")
        .bind(status,JSON.stringify(resultData),taskId).run();
      return new Response(JSON.stringify({jsonrpc:'2.0',id,result:{id:taskId,status:{state:status.toLowerCase()},artifacts:[{parts:[{kind:'data',data:resultData}]}]}}),{status:200,headers});
    }catch(e){
      // A transport timeout can happen after the facilitator settled. Keep the task
      // non-retryable and explicitly require reconciliation; never call x402 again.
      const resultData={order_status:'REVIEW_REQUIRED',message:'x402 outcome is unknown. Task is locked for reconciliation; do not resubmit payment.',error:'X402_OUTCOME_UNKNOWN'};
      await env.DB.prepare("UPDATE agent_tasks SET status='REVIEW_REQUIRED',output_json=?,updated_at=datetime('now') WHERE task_id=? AND status='PROCESSING'")
        .bind(JSON.stringify(resultData),taskId).run();
      return new Response(JSON.stringify({jsonrpc:'2.0',id,result:{id:taskId,status:{state:'review_required'},artifacts:[{parts:[{kind:'data',data:resultData}]}]}}),{status:200,headers});
    }
  }
  if(msg.method==='tasks/get'){
    await ensureP1Schema(env.DB);
    const t=await env.DB.prepare('SELECT task_id,status,output_json FROM agent_tasks WHERE task_id=?').bind(String(msg?.params?.id||'')).first();
    if(!t)return new Response(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32004,message:'Task not found'}}),{status:404,headers});
    let output={};try{output=JSON.parse(t.output_json||'{}')}catch{}
    return new Response(JSON.stringify({jsonrpc:'2.0',id,result:{id:t.task_id,status:{state:String(t.status).toLowerCase()},...(Object.keys(output).length?{artifacts:[{parts:[{kind:'data',data:output}]}]}:{})}}),{headers});
  }
  return new Response(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}}),{status:400,headers});
}

export async function emitAgentEvent(db,event){await ensureP1Schema(db);const rows=await db.prepare("SELECT webhook_id,url,events_json FROM agent_webhooks WHERE status='ACTIVE'").all();let sent=0;for(const w of (rows.results||[])){let events=[];try{events=JSON.parse(w.events_json||'[]')}catch{}if(events.length&&!events.includes(event.type))continue;try{const r=await fetch(w.url,{method:'POST',headers:{'content-type':'application/json','x-atlas-event':event.type},body:JSON.stringify({id:'evt_'+crypto.randomUUID().replaceAll('-','').slice(0,20),type:event.type,created_at:new Date().toISOString(),data:sanitizeExternalInput(event.data||{}).data}),signal:AbortSignal.timeout(5000)});if(r.ok)sent++;}catch{}}await db.prepare("INSERT INTO customer_events(event_type,entity_id,payload_json,status) VALUES(?,?,?,?)").bind(String(event.type),String(event.data?.order_id||event.data?.client_email||'unknown'),JSON.stringify(event.data||{}).slice(0,10000),String(sent?'DELIVERED':'RECORDED')).run();return {sent,recorded:true};}
