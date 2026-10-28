// ATLAS Autonomous Company Engine — P0/P1/P2 execution layer. Verified build: source + audit tests must remain green.
// External discovery is read-only by default. Commercial actions remain policy-gated.
// No provider result is treated as trusted instruction.

import { registerCapability, listCapabilities, checkBudget } from './registry.js';
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
    return {ok:res.ok,status:res.status,text:text.slice(0,100000),contentType:res.headers.get('content-type')||'',headers:{'mcp-session-id':res.headers.get('mcp-session-id')||null}};
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
const PAYANAGENT_DISCOVER_FALLBACK_URL='https://payanagent.com/api/v1/discover?q=csv&limit=50';

async function fetchPayanAgentOpenRequests(fetcher,url) {
  const primary=await fetcher(url,{method:'GET'});
  if(primary.ok || !(primary.status>=500)) return {...primary,fallbackUsed:false,requestedEndpoint:url};
  const fallback=await fetcher(PAYANAGENT_DISCOVER_FALLBACK_URL,{method:'GET'});
  return {
    ...fallback,
    fallbackUsed:true,
    primaryHttpStatus:primary.status,
    requestedEndpoint:PAYANAGENT_DISCOVER_FALLBACK_URL
  };
}

export async function scanAgentDemand(db,{fetcher=fetchJson,sources=DEFAULT_DEMAND_SOURCES,now=Date.now()}={}) {
  // Reserve budget for the one additional GET that may be used by the PayanAgent fallback.
  const externalRequests=sources.reduce((total,source)=>total+(source.protocol==='MCP'?3:(source.source==='payanagent_open_requests'?2:1)),0);
  const budget=await checkBudget(db,{external_requests:externalRequests});
  if(!budget.allowed) return {ok:false,blocked:budget.violations,signals:[]};
  const signals=[];
  const diagnostics=[];
  for(const s of sources){
    try {
      const r=s.protocol==='MCP'
        ? await fetchAgentJobPosts(fetcher)
        : (s.source==='payanagent_open_requests'
          ? await fetchPayanAgentOpenRequests(fetcher,s.url)
          : await fetcher(s.url,{method:'GET'}));
      if(!r.ok) {
        diagnostics.push({source:s.source,status:'HTTP_ERROR',http_status:r.status,
          ...(r.fallbackUsed?{fallback_used:true,primary_http_status:r.primaryHttpStatus}: {})});
        await registerCapability(db,{capability_id:s.source,kind:'marketplace',provider:s.provider||s.source,protocol:s.protocol||'API',endpoint:s.url,cost_class:'free',risk:'medium',status:'DEGRADED',metadata:{http_status:r.status}});
        continue;
      }
      const listings=extractListings(r.text);
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
        const exists=await db.prepare('SELECT id FROM demand_signals WHERE signal_key=?').bind(key).first();
        if(exists){duplicates++;continue;}
        const summary=String([lead.title,lead.description].filter(Boolean).join(' — ')).slice(0,3000);
        const score=Number((valid.score*0.7 + 0.3).toFixed(4));
        await db.prepare('INSERT INTO demand_signals(source,signal_key,request_summary,score,status) VALUES(?,?,?,?,?)')
          .bind(s.source,key,summary,score,'NEW').run();
        signals.push({source:s.source,id:lead.id,title:lead.title,score});
        accepted++;
      }
      diagnostics.push({source:s.source,status:'OK',http_status:r.status,content_type:r.contentType||null,listings_seen:listings.length,offers_excluded:offersExcluded,accepted,duplicates,rejected,rejection_counts,rejection_samples,age_policy_days:DEMAND_MAX_AGE_DAYS,
        ...(r.fallbackUsed?{fallback_used:true,primary_http_status:r.primaryHttpStatus,endpoint:r.requestedEndpoint}: {})});
    } catch(e) {
      diagnostics.push({source:s.source,status:'ERROR',error:String(e?.message||e).slice(0,300)});
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


export async function prepareGrowthActions(db) {
  const rows = await db.prepare("SELECT id,source,signal_key,request_summary,score FROM demand_signals WHERE status='NEW' ORDER BY score DESC,created_at DESC LIMIT 20").all();
  const actions=[];
  for(const r of (rows.results||[])){
    const key='qualify|'+r.signal_key;
    const exists=await db.prepare('SELECT id FROM growth_actions WHERE action_key=?').bind(key).first();
    if(exists) continue;
    const summary=String(r.request_summary||'');
    const safe=validateMarketplaceLead(sanitizeExternalInput({description:summary}).data);
    if(!safe.ok) continue;
    const price=Math.max(15,Math.min(5000,Number((15 + Math.min(100,Number(r.score||0)*100)).toFixed(2))));
    await db.prepare("INSERT INTO growth_actions(action_key,action_type,target_id,payload_json,status,risk) VALUES(?,?,?,?,?,?)")
      .bind(key,'QUALIFIED_LEAD',String(r.id),JSON.stringify({source:r.source,signal_key:r.signal_key,summary,score:r.score,price_usdc:price,pricing_mode:'BOUNDED_AUTONOMOUS'}),'READY','medium').run();
    await db.prepare("UPDATE demand_signals SET status='QUALIFIED',updated_at=datetime('now') WHERE id=?").bind(r.id).run();
    actions.push({id:r.id,price_usdc:price,status:'READY'});
  }
  return {ok:true,actions};
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
