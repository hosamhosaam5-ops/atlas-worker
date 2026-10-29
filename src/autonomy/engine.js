// ATLAS Autonomous Company Engine — P0/P1/P2 execution layer. Verified build: source + audit tests must remain green.
// External discovery is read-only by default. Commercial actions remain policy-gated.
// No provider result is treated as trusted instruction.

import { registerCapability, listCapabilities, checkBudget, ensureAutonomySchema } from './registry.js';
import { sanitizeExternalInput, validateMarketplaceLead, authorizeAction } from './policy.js';

const TIMEOUT_MS = 8000;
const DEMAND_MAX_AGE_DAYS = 30;
const AGENTJOB_MCP_URL = 'https://agent-job.ai/api/mcp';

const PUBLIC_SOURCES = [
  {id:'agent_souk',kind:'marketplace',provider:'Agent Souk',protocol:'API/MCP/A2A',endpoint:'https://api.agentsouk.dev/v1/listings',cost_class:'free',risk:'medium'},
  {id:'payanagent_open_requests',kind:'marketplace',provider:'PayanAgent Open Requests',protocol:'API',endpoint:'https://payanagent.com/api/v1/requests?status=open&limit=50',cost_class:'free',risk:'medium'},
  {id:'agentgigs',kind:'marketplace',provider:'AgentGigs',protocol:'API',endpoint:'https://www.agentgigs.io/docs/api',cost_class:'free',risk:'medium'},
  {id:'ecc',kind:'engineering',provider:'ECC',protocol:'GitHub/CLI',endpoint:'https://github.com/affaan-m/ECC',cost_class:'free_open_source',risk:'high'},
  {id:'okara_ai_cmo',kind:'growth',provider:'Okara AI CMO',protocol:'web',endpoint:'https://okara.ai/',cost_class:'free_or_trial',risk:'medium'},
  {id:'free_llm_apis',kind:'llm',provider:'Free LLM API ecosystem',protocol:'OpenAI-compatible',endpoint:'https://github.com/RandomSasquatch/AI-freellmapi-Aggregator',cost_class:'free_or_trial',risk:'medium'}
];

async function fetchJson(url, init={}) {
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url,{...init,signal:ctrl.signal,headers:{accept:'application/json,text/plain,*/*',...(init.headers||{})}});
    const text = await res.text();
    return {ok:res.ok,status:res.status,text:text.slice(0,100000),contentType:res.headers.get('content-type')||'',headers:{'mcp-session-id':res.headers.get('mcp-session-id')||null,'retry-after':res.headers.get('retry-after')||null}};
  } finally { clearTimeout(timer); }
}

export async function discoverCapabilities(db) {
  const results=[];
  for(const s of PUBLIC_SOURCES){
    try {
      const r=await fetchJson(s.endpoint,{method:'GET'});
      const status=r.ok ? 'DISCOVERY' : (r.status===401||r.status===403 ? 'AVAILABLE_AUTH_REQUIRED' : 'DEGRADED');
      const out=await registerCapability(db,{...s,capability_id:s.id,status,last_tested_at:new Date().toISOString(),metadata:{http_status:r.status,discovered:'public_probe'}});
      results.push({id:s.id,status,score:out.score,http_status:r.status});
    } catch(e) {
      const out=await registerCapability(db,{...s,capability_id:s.id,status:'UNREACHABLE',last_tested_at:new Date().toISOString(),metadata:{error:String(e?.message||e),discovered:'public_probe'}});
      results.push({id:s.id,status:'UNREACHABLE',score:out.score});
    }
  }
  return {ok:true,results};
}

// Parse common marketplace response envelopes without treating arbitrary objects as listings.
// A stable content fingerprint is used when providers omit a durable listing ID.
export function extractListings(payload){
  let data;
  try { data=typeof payload==='string'?JSON.parse(payload):payload; } catch { return []; }
  const candidates = Array.isArray(data) ? data : [
    data?.listings, data?.results, data?.items, data?.jobs, data?.tasks, data?.requests, data?.opportunities,
    // Unified discovery contains mixed supply and demand. Prefer the explicit buyer-request
    // collection so agents/offers are never mistaken for customer demand.
    data?.openRequests, data?.data?.openRequests, data?.data?.requests,
    data?.data, data?.data?.listings, data?.data?.results, data?.data?.items,
    data?.data?.jobs, data?.data?.tasks, data?.data?.opportunities, data?.agents, data?.data?.agents,
    data?.posts, data?.threads, data?.data?.posts, data?.data?.threads
  ].find(Array.isArray) || [];
  const seen=new Set();
  const out=[];
  for(const x of candidates.slice(0,100)){
    if(!x || typeof x!=='object' || Array.isArray(x)) continue;
    // Catalog listings are seller offers, not buyer demand. Never convert them to leads.
    if(x.object==='listing' || (x.pricing && x.seller && x.payment)) continue;
    const title=String(x.title??x.name??x.service??x.subject??'').trim().slice(0,500);
    const budgetHint=x.budgetMaxCents!==undefined&&x.budgetMaxCents!==null&&Number.isFinite(Number(x.budgetMaxCents)) ? ('Budget max: '+(Number(x.budgetMaxCents)/100).toFixed(2)+' '+String(x.currency??'USD')) : '';
    const description=String([x.description??x.descriptionText??x.summary??x.details??x.request??x.requirements??x.body??x.content??[...(Array.isArray(x.skillsTags)?x.skillsTags:[]),x.budgetText].filter(Boolean).join(' | '),budgetHint].filter(Boolean).join(' | ')).trim().slice(0,5000);
    const sourceUrl=String(x.url??x.href??x.listing_url??x.public_url??'').trim().slice(0,2000);
    if(!title && !description) continue;
    const providerId=x.id??x._id??x.requestId??x.listing_id??x.job_id??x.opportunity_id;
    const normalized=[title,description,sourceUrl].map(v=>v.toLowerCase().replace(/\s+/g,' ').trim()).join('|');
    const id=String(providerId??('content:'+normalized));
    if(seen.has(id)) continue;
    seen.add(id);
    out.push({id,title,description,source_url:sourceUrl,created_at:x._creationTime??x.createdAt??x.created_at??x.created??x.published_at??x.publishedAt??null,deadline:x.deadline??x.due_at??x.dueAt??x.expires_at??x.expiresAt??null,status:x.status??x.state??x.task_status??null,updated_at:x.updatedAt??x.updated_at??null,budget:x.budget??x.reward??x.price??null});
  }
  return out;
}

function countExcludedSupplyOffers(payload){
  let data;
  try { data=typeof payload==='string'?JSON.parse(payload):payload; } catch { return 0; }
  const candidates=Array.isArray(data?.data)?data.data:[];
  return candidates.filter(x=>x && typeof x==='object' && !Array.isArray(x) &&
    (x.object==='listing' || (x.pricing && x.seller && x.payment))).length;
}

// Agent Souk's public /v1/listings endpoint is a seller-offer catalog, not buyer demand.
// Keep it visible for diagnostics, but do not interpret those offers as requests.
const DEFAULT_DEMAND_SOURCES=[
  {source:'agent_souk',url:'https://api.agentsouk.dev/v1/listings',provider:'Agent Souk'},
  {source:'payanagent_open_requests',url:'https://payanagent.com/api/v1/requests?status=open&limit=50',provider:'PayanAgent Open Requests'},
  {source:'opentask_public_tasks',url:'https://opentask.ai/api/tasks?sort=new&limit=50',provider:'OpenTask Public Tasks'},
  {source:'agent_job_public_mcp',url:AGENTJOB_MCP_URL,provider:'AgentJob Task Square',protocol:'MCP'}
];

function parseMcpBody(text, contentType='') {
  const raw=String(text||'');
  if(contentType.includes('text/event-stream') || /^event:|^data:/m.test(raw)) {
    const data=raw.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).filter(Boolean);
    for(let i=data.length-1;i>=0;i--){try{return JSON.parse(data[i]);}catch{}}
  }
  try{return JSON.parse(raw);}catch{return {raw:raw.slice(0,2000)};}
}

function decodeAgentJobPosts(response) {
  let payload=parseMcpBody(response.text,response.contentType||'');
  for(let depth=0;depth<4;depth++){
    if(Array.isArray(payload?.result?.content)){
      const textPart=payload.result.content.find(x=>typeof x?.text==='string')?.text;
      if(textPart){try{payload=JSON.parse(textPart);continue;}catch{}}
    }
    if(payload?.structuredContent && typeof payload.structuredContent==='object'){payload=payload.structuredContent;continue;}
    if(payload?.result && !Array.isArray(payload.result.content)){payload=payload.result;continue;}
    break;
  }
  return payload;
}

export async function fetchAgentJobPosts(fetcher=fetchJson) {
  const headers={'content-type':'application/json','accept':'application/json, text/event-stream'};
  const init=await fetcher(AGENTJOB_MCP_URL,{method:'POST',headers,body:JSON.stringify({
    jsonrpc:'2.0',id:1,method:'initialize',
    params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'atlas-demand-scanner',version:'1.0.0'}}
  })});
  if(!init.ok) return init;
  const initPayload=parseMcpBody(init.text,init.contentType||'');
  if(initPayload?.error) return {...init,ok:false,status:502,text:JSON.stringify({error:initPayload.error})};
  const sessionId=init.headers?.['mcp-session-id']||null;
  const callHeaders={...headers,'mcp-protocol-version':'2025-03-26',...(sessionId?{'mcp-session-id':sessionId}:{})};
  await fetcher(AGENTJOB_MCP_URL,{method:'POST',headers:callHeaders,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
  const call=await fetcher(AGENTJOB_MCP_URL,{method:'POST',headers:callHeaders,body:JSON.stringify({
    jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_posts',arguments:{sort:'recent',page:1,limit:50}}
  })});
  if(!call.ok) return call;
  const payload=decodeAgentJobPosts(call);
  if(payload?.error) return {...call,ok:false,status:502,text:JSON.stringify({error:payload.error})};
  return {...call,text:JSON.stringify(payload)};
}

function parseDate(value) {
  if(value===null||value===undefined||value==='') return null;
  const n=typeof value==='number'?(value<1e12?value*1000:value):Date.parse(String(value));
  return Number.isFinite(n)?new Date(n):null;
}

export async function recordDemandScanSourceRun(db, metrics) {
  try {
    await db.prepare(`INSERT INTO demand_scan_source_runs(
      scan_id,source,raw_count,raw_recent_count,accepted_count,rejected_count,
      rejection_counts_json,duplicate_count,response_ms,http_status,source_status,error_code,
      started_at,finished_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        metrics.scan_id, metrics.source, metrics.raw_count, metrics.raw_recent_count,
        metrics.accepted_count, metrics.rejected_count, metrics.rejection_counts_json,
        metrics.duplicate_count, metrics.response_ms, metrics.http_status, metrics.source_status,
        metrics.error_code, metrics.started_at, metrics.finished_at
      ).run();
    return true;
  } catch {
    // Metrics are best-effort: an observability write must never stop demand discovery.
    return false;
  }
}

export function demandRejectionReason(lead,source,now=Date.now()) {
  const status=String(lead.status||'').trim().toLowerCase();
  if(/^(closed|complete|completed|cancelled|canceled|expired|fulfilled|archived|rejected|paid)$/.test(status)) return 'inactive_status';
  const deadline=parseDate(lead.deadline);
  if(deadline && deadline.getTime()<now) return 'expired_deadline';
  const created=parseDate(lead.created_at);
  if(created && created.getTime()<now-DEMAND_MAX_AGE_DAYS*86400000) return 'stale';
  const text=lead.title+' '+lead.description;
  // AgentJob's public feed includes provider advertisements as well as task posts.
  // Exclude explicit first-person offers and price-card titles so seller supply cannot
  // be recorded as buyer demand merely because it mentions CSV/data QA.
  if(source==='agent_job_public_mcp' && (
    /\b(?:i|we)\s+(?:offer|provide|handle|deliver|specialize in|specialise in|am available for|can deliver|can build|can create)\b/i.test(text) ||
    /\b(?:my|our)\s+(?:service|services|offer|pricing|rate|package|portfolio)\b/i.test(text) ||
    /\b(?:available for hire|hire me|book me|per paid agentjob reply|start with a public link)\b/i.test(text) ||
    /^\s*(?:[$€£]?\d+(?:\.\d+)?\s*(?:usdc|usd|eur|gbp))\s*:/i.test(String(lead.title||''))
  )) return 'seller_offer';
  // Classify explicit financial/account prerequisites before the unknown-age guard,
  // so diagnostics retain the actionable rejection reason.
  if(source==='opentask_public_tasks' && /\b(fund|deposit|pay upfront|purchase|buy|escrow)\b/i.test(text)) return 'upfront_payment_required';
  if(source==='opentask_public_tasks' && /\b(register|wallet|transaction)\b/i.test(text)) return 'registration_or_wallet_required';
  if((source==='opentask_public_tasks'||source==='agent_job_public_mcp'||source==='payanagent_open_requests') && !created && !(deadline && deadline.getTime()>=now)) return 'unverified_age';
  if((source==='opentask_public_tasks'||source==='agent_job_public_mcp'||source==='payanagent_open_requests') && !/\b(csv|xlsx|spreadsheet|dataset|data quality|data cleaning|data validation|tabular data|structured data|missing values|duplicate rows|json to csv|csv to json|data qa)\b/i.test(text)) return 'service_mismatch';
  return null;
}

// PayanAgent's unified discovery endpoint requires q and returns a distinct openRequests
// array alongside seller offers. Only invoke it after a server-side failure on the
// dedicated open-requests endpoint; both calls remain unauthenticated GET requests.
const PAYANAGENT_FILTERED_REQUESTS_FALLBACK_URL='https://payanagent.com/api/v1/requests?status=open&q=csv&limit=50';
const PAYANAGENT_DISCOVER_FALLBACK_URL='https://payanagent.com/api/v1/discover?q=csv&limit=50';

async function fetchPayanAgentOpenRequests(fetcher,url) {
  const primary=await fetcher(url,{method:'GET'});
  if(primary.ok || !(primary.status>=500)) return {...primary,fallbackUsed:false,requestedEndpoint:url};

  // The public requests route uses a different search query when q is set.
  // Try this request-only path before unified discovery so seller offers cannot
  // be mistaken for demand and a failing listOpen query can be bypassed.
  const filtered=await fetcher(PAYANAGENT_FILTERED_REQUESTS_FALLBACK_URL,{method:'GET'});
  if(filtered.ok) return {
    ...filtered,
    fallbackUsed:true,
    fallbackStage:'filtered_requests',
    primaryHttpStatus:primary.status,
    requestedEndpoint:PAYANAGENT_FILTERED_REQUESTS_FALLBACK_URL
  };
  if(!(filtered.status>=500)) return {
    ...filtered,
    fallbackUsed:true,
    fallbackStage:'filtered_requests',
    primaryHttpStatus:primary.status,
    primaryRetryAfter:primary.headers?.['retry-after']||null,
    intermediateHttpStatus:filtered.status,
    requestedEndpoint:PAYANAGENT_FILTERED_REQUESTS_FALLBACK_URL
  };

  const fallback=await fetcher(PAYANAGENT_DISCOVER_FALLBACK_URL,{method:'GET'});
  return {
    ...fallback,
    fallbackUsed:true,
    fallbackStage:'discover',
    primaryHttpStatus:primary.status,
    intermediateHttpStatus:filtered.status,
    requestedEndpoint:PAYANAGENT_DISCOVER_FALLBACK_URL
  };
}

function extractPayanAgentFallbackPayload(payload) {
  try {
    const data=typeof payload==='string'?JSON.parse(payload):payload;
    // Do not feed the unified payload directly to generic parsers: only buyer requests
    // are demand. Agents and offers in the same response are intentionally ignored.
    const requests=Array.isArray(data?.openRequests)?data.openRequests:
      (Array.isArray(data?.data?.openRequests)?data.data.openRequests:[]);
    return {requests};
  } catch { return {requests:[]}; }
}

const SOURCE_COOLDOWN_INITIAL_MS = 15 * 60 * 1000;
const SOURCE_COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000;
const SOURCE_FAILURE_THRESHOLD = 3;
const AGENTJOB_LIST_POSTS_INTERVAL_MS = 60 * 1000;

function parseRetryAfter(value, now=Date.now()) {
  const raw=String(value??'').trim();
  if(!raw) return null;
  if(/^\d+(?:\.\d+)?$/.test(raw)) return now+Math.max(0,Number(raw))*1000;
  const parsed=Date.parse(raw);
  return Number.isFinite(parsed)?Math.max(now,parsed):null;
}

async function readSourceHealth(db, sourceId) {
  return await db.prepare('SELECT * FROM demand_source_health WHERE source=?').bind(sourceId).first();
}

export async function sourceCircuitState(db, sourceId, now=Date.now()) {
  try {
    const row=await readSourceHealth(db,sourceId);
    if(!row) return {blocked:false,state:'CLOSED',probe_due:false};
    if(row.state==='HALF_OPEN') return {blocked:true,state:'HALF_OPEN',probe_due:false,reason:'probe_already_claimed'};
    if(row.state==='OPEN') {
      const next=Date.parse(row.next_probe_at||'');
      if(!Number.isFinite(next)||next>now) return {blocked:true,state:'OPEN',probe_due:false,next_probe_at:row.next_probe_at||null};
      return {blocked:false,state:'OPEN',probe_due:true,next_probe_at:row.next_probe_at};
    }
    return {blocked:false,state:'CLOSED',probe_due:false,last_error_code:row.last_error_code||null};
  } catch {
    return {blocked:true,state:'UNAVAILABLE',probe_due:false,error_code:'D1_HEALTH_READ_FAILED'};
  }
}

export async function claimHalfOpenProbe(db, sourceId, now=Date.now()) {
  const iso=new Date(now).toISOString();
  try {
    const row=await db.prepare(`UPDATE demand_source_health
      SET state='HALF_OPEN',updated_at=?
      WHERE source=? AND state='OPEN' AND next_probe_at IS NOT NULL
        AND julianday(next_probe_at)<=julianday(?)
      RETURNING source`).bind(iso,sourceId,iso).first();
    return !!row;
  } catch {
    return false;
  }
}

export async function claimAgentJobListPostsGate(db, sourceId='agent_job_public_mcp', now=Date.now()) {
  const iso=new Date(now).toISOString();
  try {
    const row=await db.prepare(`INSERT INTO demand_source_health(
        source,state,consecutive_failures,cooldown_ms,last_attempt_at,updated_at
      ) VALUES(?,'CLOSED',0,900000,?,?)
      ON CONFLICT(source) DO UPDATE SET
        last_attempt_at=excluded.last_attempt_at,
        updated_at=excluded.updated_at
      WHERE demand_source_health.last_attempt_at IS NULL
        OR (julianday(excluded.last_attempt_at)-julianday(demand_source_health.last_attempt_at))*86400 >= ?
      RETURNING last_attempt_at`).bind(sourceId,iso,iso,AGENTJOB_LIST_POSTS_INTERVAL_MS/1000).first();
    return {allowed:!!row,last_attempt_at:row?.last_attempt_at||null};
  } catch {
    return {allowed:false,last_attempt_at:null,reason:'D1_POLL_GATE_UNAVAILABLE'};
  }
}

export async function recordSourceOutcome(db, sourceId, {
  ok,status=null,error=null,retryAfter=null,responseMs=null,now=Date.now()
}) {
  const previous=await readSourceHealth(db,sourceId);
  const numericStatus=Number(status);
  const httpStatus=Number.isFinite(numericStatus)?numericStatus:null;
  const timeout=String(status||'').toUpperCase()==='TIMEOUT'||String(error||'').toUpperCase()==='TIMEOUT';
  const rateLimited=httpStatus===429;
  const authRequired=httpStatus===401||httpStatus===403;
  let state='CLOSED';
  let failures=0;
  let cooldownMs=SOURCE_COOLDOWN_INITIAL_MS;
  let openedAt=null;
  let nextProbeAt=null;
  let lastErrorCode=null;
  let lastSuccessAt=null;

  if(ok===true) {
    lastSuccessAt=new Date(now).toISOString();
  } else if(rateLimited) {
    state='OPEN';
    failures=Math.min(100,Number(previous?.consecutive_failures||0));
    cooldownMs=Math.min(SOURCE_COOLDOWN_MAX_MS,Math.max(SOURCE_COOLDOWN_INITIAL_MS,Number(previous?.cooldown_ms||SOURCE_COOLDOWN_INITIAL_MS)));
    const retryAt=parseRetryAfter(retryAfter,now);
    nextProbeAt=new Date(retryAt??(now+cooldownMs)).toISOString();
    openedAt=new Date(now).toISOString();
    lastErrorCode='RATE_LIMITED';
  } else if(authRequired) {
    lastErrorCode='AUTH_REQUIRED';
  } else if((httpStatus!==null&&httpStatus>=500)||timeout) {
    failures=Math.min(100,Number(previous?.consecutive_failures||0)+1);
    lastErrorCode=timeout?'TIMEOUT':(error==='PRIMARY_HTTP_ERROR'?'PRIMARY_HTTP_ERROR':'HTTP_'+httpStatus);
    if(failures>=SOURCE_FAILURE_THRESHOLD) {
      state='OPEN';
      const priorCooldown=Math.max(SOURCE_COOLDOWN_INITIAL_MS,Number(previous?.cooldown_ms||SOURCE_COOLDOWN_INITIAL_MS));
      cooldownMs=previous?.state==='HALF_OPEN'
        ? Math.min(SOURCE_COOLDOWN_MAX_MS,priorCooldown*2)
        : Math.min(SOURCE_COOLDOWN_MAX_MS,priorCooldown);
      openedAt=new Date(now).toISOString();
      nextProbeAt=new Date(now+cooldownMs).toISOString();
    } else {
      cooldownMs=Math.min(SOURCE_COOLDOWN_MAX_MS,Math.max(SOURCE_COOLDOWN_INITIAL_MS,Number(previous?.cooldown_ms||SOURCE_COOLDOWN_INITIAL_MS)));
    }
  } else {
    lastErrorCode=error?String(error).slice(0,120):(httpStatus!==null?'HTTP_'+httpStatus:null);
  }

  const iso=new Date(now).toISOString();
  const row=await db.prepare(`INSERT INTO demand_source_health(
      source,state,consecutive_failures,opened_at,next_probe_at,cooldown_ms,
      last_status,last_error_code,last_success_at,last_http_status,last_response_ms,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source) DO UPDATE SET
      state=excluded.state,
      consecutive_failures=excluded.consecutive_failures,
      opened_at=excluded.opened_at,
      next_probe_at=excluded.next_probe_at,
      cooldown_ms=excluded.cooldown_ms,
      last_status=excluded.last_status,
      last_error_code=excluded.last_error_code,
      last_success_at=COALESCE(excluded.last_success_at,demand_source_health.last_success_at),
      last_http_status=excluded.last_http_status,
      last_response_ms=excluded.last_response_ms,
      updated_at=excluded.updated_at
    RETURNING *`).bind(
      sourceId,state,failures,openedAt,nextProbeAt,cooldownMs,httpStatus,lastErrorCode,lastSuccessAt,
      httpStatus,Number.isFinite(Number(responseMs))?Math.max(0,Number(responseMs)):null,iso
    ).first();
  return {
    source:sourceId,state:row?.state||state,
    consecutive_failures:Number(row?.consecutive_failures??failures),
    cooldown_ms:Number(row?.cooldown_ms??cooldownMs),
    next_probe_at:row?.next_probe_at||null,
    last_error_code:row?.last_error_code||null
  };
}

export async function recordPayanAgentOutcome(db, sourceId, response, now=Date.now()) {
  const primaryFailed=sourceId==='payanagent_open_requests'&&Number(response?.primaryHttpStatus)>=500;
  const outcome=await recordSourceOutcome(db,sourceId,{
    ok:response?.ok===true&&!primaryFailed,
    status:primaryFailed?response.primaryHttpStatus:response?.status,
    error:primaryFailed?'PRIMARY_HTTP_ERROR':(response?.ok===true?null:'HTTP_ERROR'),
    retryAfter:response?.primaryRetryAfter||response?.headers?.['retry-after']||null,
    responseMs:response?.responseMs??null,
    now
  });
  return {...outcome,primary_degraded:primaryFailed};
}

export async function scanAgentDemand(db,{fetcher=fetchJson,sources=DEFAULT_DEMAND_SOURCES,now=Date.now()}={}) {
  await ensureAutonomySchema(db);
  // Reserve budget for the one additional GET that may be used by the PayanAgent fallback.
  const externalRequests=sources.reduce((total,source)=>total+(source.protocol==='MCP'?3:(source.source==='payanagent_open_requests'?3:1)),0);
  const budget=await checkBudget(db,{external_requests:externalRequests});
  if(!budget.allowed) return {ok:false,blocked:budget.violations,signals:[]};
  const scanId=crypto.randomUUID();
  const signals=[];
  const diagnostics=[];
  for(const s of sources){
    const startedAtMs=Date.now();
    let requestStartedAtMs=0;
    let requestCompleted=false;
    const metrics={
      scan_id:scanId,source:s.source,raw_count:0,raw_recent_count:0,accepted_count:0,
      rejected_count:0,rejection_counts_json:'{}',duplicate_count:0,response_ms:0,
      http_status:null,source_status:'NOT_STARTED',error_code:null,
      started_at:new Date(startedAtMs).toISOString(),finished_at:null
    };
    const flushMetrics=async()=>{
      metrics.finished_at=new Date().toISOString();
      await recordDemandScanSourceRun(db,metrics);
    };
    const circuit = await sourceCircuitState(db, s.source, now);
    if (circuit.blocked) {
      metrics.source_status=circuit.state==='UNAVAILABLE'?'HEALTH_STORE_UNAVAILABLE':'CIRCUIT_OPEN';
      metrics.error_code=circuit.error_code||'CIRCUIT_OPEN';
      await flushMetrics();
      diagnostics.push({source:s.source,status:metrics.source_status,state:circuit.state,
        next_probe_at:circuit.next_probe_at||null,reason:circuit.reason||'source_circuit_blocked'});
      continue;
    }
    if(s.source==='agent_job_public_mcp') {
      const gate=await claimAgentJobListPostsGate(db,s.source,now);
      if(!gate.allowed) {
        metrics.source_status=gate.reason?'POLL_GATE_UNAVAILABLE':'POLL_GATE';
        metrics.error_code=gate.reason||'POLL_INTERVAL_NOT_ELAPSED';
        await flushMetrics();
        diagnostics.push({source:s.source,status:metrics.source_status,reason:metrics.error_code});
        continue;
      }
    }
    if(circuit.probe_due) {
      const claimed=await claimHalfOpenProbe(db,s.source,now);
      if(!claimed) {
        metrics.source_status='CIRCUIT_OPEN';
        metrics.error_code='HALF_OPEN_PROBE_ALREADY_CLAIMED';
        await flushMetrics();
        diagnostics.push({source:s.source,status:'CIRCUIT_OPEN',reason:'half_open_probe_already_claimed'});
        continue;
      }
    }
    try {
      requestStartedAtMs=Date.now();
      const r=s.protocol==='MCP'
        ? await fetchAgentJobPosts(fetcher)
        : (s.source==='payanagent_open_requests'
          ? await fetchPayanAgentOpenRequests(fetcher,s.url)
          : await fetcher(s.url,{method:'GET'}));
      requestCompleted=true;
      metrics.response_ms=Math.max(0,Date.now()-requestStartedAtMs);
      metrics.http_status=Number.isFinite(Number(r.status))?Number(r.status):null;
      if(!r.ok) {
        metrics.source_status='HTTP_ERROR';
        metrics.error_code=metrics.http_status===null?'HTTP_ERROR':'HTTP_'+metrics.http_status;
        await recordSourceOutcome(db, s.source, {ok:false,status:r.status,error:'HTTP_ERROR',retryAfter:r.headers?.['retry-after']||null,responseMs:metrics.response_ms,now});
        diagnostics.push({source:s.source,status:'HTTP_ERROR',http_status:r.status,
          ...(r.fallbackUsed?{
            fallback_used:true,
            fallback_stage:r.fallbackStage||null,
            primary_http_status:r.primaryHttpStatus,
            ...(r.intermediateHttpStatus!==undefined?{intermediate_http_status:r.intermediateHttpStatus}: {}),
            endpoint:r.requestedEndpoint
          }: {})});
        await registerCapability(db,{capability_id:s.source,kind:'marketplace',provider:s.provider||s.source,protocol:s.protocol||'API',endpoint:s.url,cost_class:'free',risk:'medium',status:'DEGRADED',metadata:{http_status:r.status}});
        await flushMetrics();
        continue;
      }
      const sourceOutcome = s.source==='payanagent_open_requests'
        ? await recordPayanAgentOutcome(db, s.source, {...r,responseMs:metrics.response_ms}, now)
        : await recordSourceOutcome(db, s.source, {ok:true,status:r.status,responseMs:metrics.response_ms,now});
      const listings=(s.source==='payanagent_open_requests' && r.fallbackStage==='discover')
        ? extractListings(extractPayanAgentFallbackPayload(r.text))
        : extractListings(r.text);
      metrics.raw_count=listings.length;
      const recentCutoff=now-DEMAND_MAX_AGE_DAYS*86400000;
      metrics.raw_recent_count=listings.filter(lead=>{
        const created=parseDate(lead.created_at);
        return !!created && created.getTime()>=recentCutoff && created.getTime()<=now;
      }).length;
      const offersExcluded=countExcludedSupplyOffers(r.text);
      let accepted=0,duplicates=0,rejected=0;
      const rejection_counts={};
      const rejection_samples=[];
      for(const lead of listings){
        const reason=demandRejectionReason(lead,s.source,now);
        if(reason){
          rejected++;
          rejection_counts[reason]=(rejection_counts[reason]||0)+1;
          if(rejection_samples.length<10) rejection_samples.push({id:lead.id,title:lead.title,reason});
          continue;
        }
        const safe=sanitizeExternalInput(lead);
        const valid=validateMarketplaceLead(safe.data);
        if(!valid.ok){
          rejected++;
          const why=valid.reason==='HIGH_RISK_REQUEST'?'service_mismatch_or_high_risk':(valid.reason||'invalid_lead');
          rejection_counts[why]=(rejection_counts[why]||0)+1;
          if(rejection_samples.length<10) rejection_samples.push({id:lead.id,title:lead.title,reason:why});
          continue;
        }
        const key=s.source+'|'+lead.id;
        const exists=await db.prepare('SELECT id,source_url FROM demand_signals WHERE signal_key=?').bind(key).first();
        const sourceCreatedAt=parseDate(lead.created_at);
        const sourceUrl=sourceCreatedAt&&lead.source_url?lead.source_url:null;
        const storedCreatedAt=sourceCreatedAt?sourceCreatedAt.toISOString():new Date(now).toISOString();
        if(exists){
          duplicates++;
          if(!exists.source_url&&sourceUrl){
            await db.prepare("UPDATE demand_signals SET source_url=?,created_at=? WHERE id=? AND status='NEW' AND source_url IS NULL")
              .bind(sourceUrl,storedCreatedAt,exists.id).run();
          }
          continue;
        }
        const summary=String([lead.title,lead.description].filter(Boolean).join(' — ')).slice(0,3000);
        const score=Number((valid.score*0.7 + 0.3).toFixed(4));
        // Preserve the provider's original creation time for the phase-4 age gate.
        // If age cannot be proven, keep source_url NULL so the signal cannot be counted.
        await db.prepare('INSERT INTO demand_signals(source,signal_key,request_summary,score,status,source_url,created_at) VALUES(?,?,?,?,?,?,?)')
          .bind(s.source,key,summary,score,'NEW',sourceUrl,storedCreatedAt).run();
        signals.push({source:s.source,id:lead.id,title:lead.title,score});
        accepted++;
      }
      metrics.accepted_count=accepted;
      metrics.rejected_count=rejected;
      metrics.duplicate_count=duplicates;
      metrics.rejection_counts_json=JSON.stringify(rejection_counts);
      metrics.source_status=sourceOutcome.primary_degraded?'FALLBACK_OK_PRIMARY_DEGRADED':'OK';
      if(sourceOutcome.primary_degraded) metrics.error_code='PRIMARY_HTTP_ERROR';
      diagnostics.push({source:s.source,status:sourceOutcome.primary_degraded?'FALLBACK_OK_PRIMARY_DEGRADED':'OK',http_status:r.status,content_type:r.contentType||null,listings_seen:listings.length,offers_excluded:offersExcluded,accepted,duplicates,rejected,rejection_counts,rejection_samples,age_policy_days:DEMAND_MAX_AGE_DAYS,
        ...(sourceOutcome.primary_degraded?{primary_degraded:true,circuit_state:sourceOutcome.state,cooldown_until:sourceOutcome.cooldown_until}:{}),
        ...(r.fallbackUsed?{
          fallback_used:true,
          fallback_stage:r.fallbackStage||null,
          primary_http_status:r.primaryHttpStatus,
          ...(r.intermediateHttpStatus!==undefined?{intermediate_http_status:r.intermediateHttpStatus}: {}),
          endpoint:r.requestedEndpoint
        }: {})});
      await flushMetrics();
    } catch(e) {
      const message=String(e?.message||e);
      if(!requestCompleted && requestStartedAtMs) metrics.response_ms=Math.max(0,Date.now()-requestStartedAtMs);
      const timeout=e?.name==='AbortError'||e?.name==='TimeoutError'||/timed?\s*out|timeout|aborted/i.test(message);
      metrics.source_status=timeout?'TIMEOUT':'ERROR';
      metrics.error_code=timeout?'TIMEOUT':'NETWORK_ERROR';
      try {
        await recordSourceOutcome(db, s.source, {ok:false,status:timeout?'TIMEOUT':'NETWORK_ERROR',error:timeout?'TIMEOUT':'NETWORK_ERROR',responseMs:metrics.response_ms,now});
      } catch { /* D1 health-store failures must not abort scans for other sources. */ }
      diagnostics.push({source:s.source,status:'ERROR',error:message.slice(0,300)});
      await flushMetrics();
    }
  }
  return {ok:true,signals,diagnostics};
}

export function selectLLMRoute(env,{preferFree=true}={}) {
  const routes=[];
  if(env.AI && typeof env.AI.run==='function') routes.push({provider:'WORKERS_AI',model:env.AI_MODEL||'@cf/zai-org/glm-4.7-flash',cost:'free_quota'});
  if(env.OPENROUTER_API_KEY) routes.push({provider:'OPENROUTER',model:env.OPENROUTER_FREE_MODEL||'openrouter/free',cost:'free_models'});
  return preferFree ? routes.filter(x=>x.cost!=='paid') : routes;
}

function buildAutonomousDecision(db,action,context={}) {
  return authorizeAction(action,context);
}


function isPrivateSourceHost(hostname) {
  const host=String(hostname||'').toLowerCase().replace(/^\[|\]$/g,'');
  if(!host||host==='localhost'||host==='::1'||host==='::'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')) return true;
  const octets=host.split('.').map(Number);
  if(octets.length===4&&octets.every(n=>Number.isInteger(n)&&n>=0&&n<=255)){
    const [a,b]=octets;
    if(a===0||a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)) return true;
  }
  if(/^(?:fc|fd|fe80:)/i.test(host)||host.startsWith('::ffff:127.')||host.startsWith('::ffff:10.')) return true;
  return false;
}

export async function verifyOriginalSourceLink(sourceUrl, fetcher=fetch) {
  let url;
  try {
    url=new URL(String(sourceUrl||''));
  } catch {
    return {ok:false,reason:'INVALID_SOURCE_URL'};
  }
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||isPrivateSourceHost(url.hostname)) {
    return {ok:false,reason:'UNSAFE_SOURCE_URL'};
  }
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),8000);
  try {
    let response=await fetcher(url.toString(),{method:'HEAD',redirect:'follow',signal:controller.signal});
    if(response.status===405||response.status===501) {
      response=await fetcher(url.toString(),{method:'GET',headers:{Range:'bytes=0-0'},redirect:'follow',signal:controller.signal});
    }
    const ok=response.ok===true&&Number(response.status)>=200&&Number(response.status)<300;
    try { await response.body?.cancel?.(); } catch {}
    return {ok,status:Number(response.status)||null,reason:ok?null:'SOURCE_LINK_NOT_OPEN'};
  } catch(error) {
    const timeout=error?.name==='AbortError'||error?.name==='TimeoutError';
    return {ok:false,status:null,reason:timeout?'SOURCE_LINK_TIMEOUT':'SOURCE_LINK_UNREACHABLE'};
  } finally {
    clearTimeout(timer);
  }
}

export async function prepareGrowthActions(db,{now=Date.now(),linkFetcher=fetch}={}) {
  const rows=await db.prepare("SELECT id,source,signal_key,request_summary,score,source_url,created_at,status FROM demand_signals WHERE status='NEW' ORDER BY score DESC,created_at DESC LIMIT 20").all();
  const actions=[];
  const skipped={};
  const skip=reason=>{skipped[reason]=(skipped[reason]||0)+1;};
  const capabilityPattern=/\b(csv|xlsx|spreadsheet|dataset|data quality|data cleaning|data validation|tabular data|structured data|missing values|duplicate rows|json to csv|csv to json|data qa)\b/i;
  const financialPrerequisitePattern=/\b(?:pay\s+upfront|upfront\s+payment|deposit\s+required|pay\s+a\s+deposit|funding\s+required|purchase\s+required|buy\s+now|escrow\s+required|paid\s+registration|registration\s+fee|paid\s+membership|wallet\s+required|transaction\s+required)\b/i;
  for(const r of (rows.results||[])){
    const summary=String(r.request_summary||'');
    const created=parseDate(r.created_at);
    if(!created||created.getTime()>now){skip('unverified_age');continue;}
    if(created.getTime()<now-DEMAND_MAX_AGE_DAYS*86400000){skip('stale');continue;}
    if(!r.source_url){skip('missing_source_url');continue;}
    if(financialPrerequisitePattern.test(summary)){skip('financial_prerequisite');continue;}
    const sourceReason=demandRejectionReason({title:summary,description:'',created_at:r.created_at,status:'open'},r.source,now);
    if(sourceReason){skip(sourceReason);continue;}
    if(!capabilityPattern.test(summary)){skip('service_mismatch');continue;}

    const canonical=await db.prepare('SELECT MIN(id) AS canonical_id,COUNT(*) AS duplicate_count FROM demand_signals WHERE signal_key=?').bind(r.signal_key).first();
    if(Number(canonical?.duplicate_count||0)>1&&Number(canonical?.canonical_id)!==Number(r.id)){skip('duplicate_signal');continue;}

    const key='qualify|'+r.signal_key;
    const exists=await db.prepare('SELECT id FROM growth_actions WHERE action_key=?').bind(key).first();
    if(exists){skip('action_already_exists');continue;}

    const link=await verifyOriginalSourceLink(r.source_url,linkFetcher);
    if(!link.ok){skip(link.reason||'source_link_unavailable');continue;}

    const safe=validateMarketplaceLead(sanitizeExternalInput({description:summary}).data);
    if(!safe.ok){skip(safe.reason||'invalid_lead');continue;}
    const price=Math.max(15,Math.min(5000,Number((15+Math.min(100,Number(r.score||0)*100)).toFixed(2))));
    const verifiedAt=new Date(now).toISOString();
    const payload=JSON.stringify({
      source:r.source,signal_key:r.signal_key,summary,score:r.score,price_usdc:price,
      pricing_mode:'BOUNDED_AUTONOMOUS',source_url:r.source_url,last_verified_at:verifiedAt
    });
    const insert=db.prepare("INSERT INTO growth_actions(action_key,action_type,target_id,payload_json,status,risk) VALUES(?,?,?,?,?,?)")
      .bind(key,'QUALIFIED_LEAD',String(r.id),payload,'READY','medium');
    const update=db.prepare("UPDATE demand_signals SET status='QUALIFIED',last_verified_at=?,updated_at=datetime('now') WHERE id=? AND status='NEW' AND source_url=?")
      .bind(verifiedAt,r.id,r.source_url);
    if(typeof db.batch==='function') {
      await db.batch([insert,update]);
    } else {
      await insert.run();
      await update.run();
    }
    actions.push({id:r.id,price_usdc:price,status:'READY',last_verified_at:verifiedAt});
  }
  return {ok:true,actions,skipped};
}

async function queueEngineeringJob(db,{source='customer_request',request_summary,risk='high'}={}) {
  const safe = sanitizeExternalInput({request_summary}).data.request_summary;
  if(!String(safe||'').trim()) throw new Error('EMPTY_ENGINEERING_REQUEST');
  const gate = authorizeAction('engineering_queue', {sensitive: risk === 'critical', outboundSpend: false, majorStrategy: false});
  if(!gate.allowed) throw new Error(gate.reason);
  const jobId='ENG-'+crypto.randomUUID().replaceAll('-','').slice(0,16);
  await db.prepare("INSERT INTO engineering_jobs(job_id,source,request_summary,status,risk,sandbox) VALUES(?,?,?,?,?,?)")
    .bind(jobId,source,String(safe).slice(0,10000),'QUEUED',risk,'SAFE_ADMISSION_ONLY').run();
  return {ok:true,job_id:jobId,status:'QUEUED',executor:'SAFE_ADMISSION_ONLY',execution:'NOT_ENABLED',reason:'No untrusted-code runtime is configured; job is queued without execution'};
}

export async function acquisitionCycle(db) {
  const discovery=await discoverCapabilities(db);
  const demand=await scanAgentDemand(db);
  const growth=await prepareGrowthActions(db);
  return {ok:true,discovery,demand,growth,next_action:'AUTHENTICATED_EXTERNAL_CHANNEL_REQUIRED_FOR_APPLY_MESSAGE_OR_ORDER'};
}
