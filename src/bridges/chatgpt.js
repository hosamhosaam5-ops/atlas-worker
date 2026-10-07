// CHATGPT BRIDGE — production bridge for ATLAS Worker.
// Authenticated operations are explicit; no arbitrary SQL or code execution is exposed.
import { processUpdate } from '../ceo/pipeline.js';

const WHITELIST = ['health','read_state','read_tables','read_workflow_metadata','execute_ceo'];

export function parseAndAuthorize(body) {
  const src = (body && typeof body === 'object') ? body : {};
  const requestId = 'brg_' + crypto.randomUUID();
  const op = String(src.operation || '').trim();
  const whitelisted = WHITELIST.includes(op);
  return { request_id: requestId, operation: op, auth_result: 'OK', whitelisted, reject: whitelisted ? 'OK' : 'REJECTED', timestamp: new Date().toISOString() };
}

async function executeCeo(env, body, requestId) {
  const message=String(body.founder_message||'').trim(), founderChatId=String(env.FOUNDER_CHAT_ID||'').trim(), messageId=Number(body.message_id);
  if (!message || !founderChatId || !Number.isInteger(messageId)) throw new Error('INVALID_CEO_REQUEST');
  const chatId=founderChatId;
  // Deterministic identity: retries of the same ChatGPT request must not create a new event.
  const externalId='chatgpt|' + chatId + '|' + String(messageId);
  const update={update_id:externalId,__source:'bridge',message:{message_id:messageId,chat:{id:chatId},from:{id:0},text:message}};
  const inserted=await env.DB.prepare('INSERT INTO event_log (source, external_id, payload_json, status) VALUES (?,?,?,"QUEUED") ON CONFLICT(source, external_id) DO NOTHING').bind('chatgpt',externalId,JSON.stringify(update)).run();
  const row=await env.DB.prepare('SELECT id,status FROM event_log WHERE source=? AND external_id=?').bind('chatgpt',externalId).first();
  if(!row?.id) throw new Error('EVENT_LOG_INSERT_FAILED');
  if(inserted.meta?.changes===0) {
    if(row.status==='PROCESSED' || row.status==='PROCESSED_DUPLICATE_REUSED') return {outcome:'DUPLICATE_REJECTED',request_id:requestId};
    return {outcome:'DUPLICATE_IN_PROGRESS',request_id:requestId,status:row.status};
  }
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
  // Compare a fixed-size HMAC digest so the secret itself is never compared by early-exit string equality.
  const suppliedKey=String(request.headers.get('x-atlas-bridge-key')||'');
  const hmacKey=await crypto.subtle.importKey('raw',new TextEncoder().encode('ATLAS-BRIDGE-COMPARE-V1'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const [expectedDigest,suppliedDigest]=await Promise.all([
    crypto.subtle.sign('HMAC',hmacKey,new TextEncoder().encode(secret)),
    crypto.subtle.sign('HMAC',hmacKey,new TextEncoder().encode(suppliedKey))
  ]);
  const expected=new Uint8Array(expectedDigest), supplied=new Uint8Array(suppliedDigest);
  let diff=expected.length===supplied.length?0:1;
  for(let i=0;i<Math.max(expected.length,supplied.length);i++) diff|=(expected[i%expected.length]||0)^(supplied[i%supplied.length]||0);
  if(diff!==0)return new Response(JSON.stringify({status:'UNAUTHORIZED'}),{status:401,headers:{'content-type':'application/json'}});
  let body={};try{body=await request.json();}catch(e){}
  const meta=parseAndAuthorize(body),out=await buildBridgeResponse(env,meta,adapters,body);
  try{
    const callerIp=String(request.headers.get('cf-connecting-ip')||'').slice(0,128);
    const userAgent=String(request.headers.get('user-agent')||'').slice(0,512);
    const chatId=String(body?.chat_id || env.FOUNDER_CHAT_ID || '').slice(0,128);
    await env.DB.prepare('INSERT INTO bridge_audit (request_id, operation, status, auth_result, timestamp, error_summary, caller_ip, user_agent, chat_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(out.audit.request_id,out.audit.operation,out.audit.status,out.audit.auth_result,out.audit.timestamp,out.audit.error_summary,callerIp,userAgent,chatId).run();
  }catch(e){}
  return new Response(JSON.stringify(out.response),{status:out.response.status==='ERROR'?400:200,headers:{'content-type':'application/json'}});
}
