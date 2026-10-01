// CHATGPT BRIDGE — production bridge for ATLAS Worker.
// Authenticated operations are explicit; no arbitrary SQL or code execution is exposed.
import { processUpdate } from '../ceo/pipeline.js';

const WHITELIST = ['health','read_state','read_tables','read_workflow_metadata','write_state','write_memory','execute_ceo'];

export function parseAndAuthorize(body) {
  const src = (body && typeof body === 'object') ? body : {};
  const requestId = 'brg_' + crypto.randomUUID();
  const op = String(src.operation || '').trim();
  const whitelisted = WHITELIST.includes(op);
  return { request_id: requestId, operation: op, auth_result: 'OK', whitelisted, reject: whitelisted ? 'OK' : 'REJECTED', timestamp: new Date().toISOString() };
}

async function writeState(env, rows) {
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('INVALID_STATE_ROWS');
  let written = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !r.idempotency_key) throw new Error('INVALID_STATE_ROW');
    const payload = r.payload_json !== undefined ? String(r.payload_json) : JSON.stringify(r.payload ?? {});
    await env.DB.prepare(
      'INSERT INTO execution_state (idempotency_key, record_kind, correlation_id, request_id, entity_type, entity_id, action_id, tool, status, progress, payload_json, error_code, attempt_count, delivery_state, message_key, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime("now"),datetime("now")) ON CONFLICT(idempotency_key) DO UPDATE SET record_kind=excluded.record_kind, correlation_id=excluded.correlation_id, request_id=excluded.request_id, entity_type=excluded.entity_type, entity_id=excluded.entity_id, action_id=excluded.action_id, tool=excluded.tool, status=excluded.status, progress=excluded.progress, payload_json=excluded.payload_json, error_code=excluded.error_code, attempt_count=excluded.attempt_count, delivery_state=excluded.delivery_state, message_key=excluded.message_key, expires_at=excluded.expires_at, updated_at=datetime("now")'
    ).bind(String(r.idempotency_key),r.record_kind??null,r.correlation_id??null,r.request_id??null,r.entity_type??null,r.entity_id??null,r.action_id??null,r.tool??null,r.status??null,r.progress??null,payload,r.error_code??null,r.attempt_count??0,r.delivery_state??null,r.message_key??null,r.expires_at??null).run();
    written++;
  }
  return {written};
}

async function writeMemory(env, rows) {
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('INVALID_MEMORY_ROWS');
  let written = 0;
  for (const r of rows) {
    if (!r || !String(r.category||'').trim() || !String(r.content||'').trim()) throw new Error('INVALID_MEMORY_ROW');
    await env.DB.prepare('INSERT INTO ceo_memory (category, content, created_at) VALUES (?,?,datetime("now"))').bind(String(r.category).trim(),String(r.content).trim()).run();
    written++;
  }
  return {written};
}

async function executeCeo(env, body, requestId) {
  const message=String(body.founder_message||'').trim(), chatId=String(body.chat_id||'').trim(), messageId=Number(body.message_id);
  if (!message || !chatId || !Number.isInteger(messageId)) throw new Error('INVALID_CEO_REQUEST');
  const update={update_id:requestId,message:{message_id:messageId,chat:{id:chatId},text:message}};
  const inserted=await env.DB.prepare('INSERT INTO event_log (source, external_id, payload_json, status) VALUES (?,?,?,"QUEUED") ON CONFLICT(source, external_id) DO NOTHING').bind('chatgpt',requestId,JSON.stringify(update)).run();
  const row=await env.DB.prepare('SELECT id,status FROM event_log WHERE source=? AND external_id=?').bind('chatgpt',requestId).first();
  if(!row?.id) throw new Error('EVENT_LOG_INSERT_FAILED');
  if(inserted.meta?.changes===0 && row.status==='PROCESSED') return {outcome:'DUPLICATE_REJECTED',request_id:requestId};
  const timings={};
  return await processUpdate(env,update,row.id,timings);
}

export async function buildBridgeResponse(env, meta, adapters, body={}) {
  const op=meta.operation; let data={}; const errors=[]; let status=meta.reject==='OK'?'SUCCESS':meta.reject;
  try {
    if(meta.reject!=='OK') throw new Error('REJECTED_OPERATION');
    if(op==='health') data={service:'ATLAS ChatGPT Bridge',version:'V2',mode:'READ_WRITE_EXECUTE',capabilities:WHITELIST,execute:'AVAILABLE',time:new Date().toISOString()};
    else if(op==='read_state') data={atlas_execution_state:await adapters.readExecutionState(env)};
    else if(op==='read_tables'){const rows=await adapters.readCeoMemory(env);data={ceo_memory_count:rows.length,ceo_memory_sample:rows.slice(0,5),ceo_state:'STORED_IN atlas_execution_state WITH record_kind=ceo_state'};}
    else if(op==='read_workflow_metadata') data={bridge:{name:'ATLAS — ChatGPT Bridge',mode:'READ_WRITE_EXECUTE',version:'V2'},production_executions:'NATIVE_WORKER',draft_diff:'GITHUB_SOURCE'};
    else if(op==='write_state') data=await writeState(env,body.rows);
    else if(op==='write_memory') data=await writeMemory(env,body.rows);
    else if(op==='execute_ceo') data=await executeCeo(env,body,meta.request_id);
  } catch(e){status='ERROR';errors.push(String(e?.message||e).slice(0,500));}
  return {response:{request_id:meta.request_id,operation:op||'UNKNOWN',status,timestamp:new Date().toISOString(),data,errors},audit:{request_id:meta.request_id,operation:op||'UNKNOWN',status,auth_result:meta.auth_result,timestamp:new Date().toISOString(),error_summary:errors[0]||''}};
}

export const defaultAdapters={
  async readExecutionState(env){const {results}=await env.DB.prepare('SELECT * FROM execution_state').all();return results||[];},
  async readCeoMemory(env){const {results}=await env.DB.prepare('SELECT * FROM ceo_memory').all();return results||[];}
};

export async function handleChatGptBridge(request,env,adapters=defaultAdapters){
  const secret=env.CHATGPT_BRIDGE_SECRET;
  if (!secret) return new Response(JSON.stringify({status:'BRIDGE_NOT_CONFIGURED'}),{status:503,headers:{'content-type':'application/json'}});
  if(request.headers.get('x-atlas-bridge-key')!==secret)return new Response(JSON.stringify({status:'UNAUTHORIZED'}),{status:401,headers:{'content-type':'application/json'}});
  let body={};try{body=await request.json();}catch(e){}
  const meta=parseAndAuthorize(body),out=await buildBridgeResponse(env,meta,adapters,body);
  try{await env.DB.prepare('INSERT INTO bridge_audit (request_id, operation, status, auth_result, timestamp, error_summary) VALUES (?,?,?,?,?,?)').bind(out.audit.request_id,out.audit.operation,out.audit.status,out.audit.auth_result,out.audit.timestamp,out.audit.error_summary).run();}catch(e){}
  return new Response(JSON.stringify(out.response),{status:out.response.status==='ERROR'?400:200,headers:{'content-type':'application/json'}});
}
