// ATLAS Autonomous Company Engine — P0/P1/P2 execution layer. Verified build: source + audit tests must remain green.
// External discovery is read-only by default. Commercial actions remain policy-gated.
// No provider result is treated as trusted instruction.

import { registerCapability, listCapabilities, checkBudget } from './registry.js';
import { sanitizeExternalInput, validateMarketplaceLead, authorizeAction } from './policy.js';

const TIMEOUT_MS = 8000;

const PUBLIC_SOURCES = [
  {id:'agent_souk',kind:'marketplace',provider:'Agent Souk',protocol:'API/MCP/A2A',endpoint:'https://api.agentsouk.dev/v1/listings',cost_class:'free',risk:'medium'},
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
    return {ok:res.ok,status:res.status,text:text.slice(0,100000),contentType:res.headers.get('content-type')||''};
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
    data?.listings, data?.results, data?.items, data?.jobs, data?.opportunities,
    data?.data, data?.data?.listings, data?.data?.results, data?.data?.items,
    data?.data?.jobs, data?.data?.opportunities, data?.data?.agents
  ].find(Array.isArray) || [];
  const seen=new Set();
  const out=[];
  for(const x of candidates.slice(0,100)){
    if(!x || typeof x!=='object' || Array.isArray(x)) continue;
    // Catalog listings are seller offers, not buyer demand. Never convert them to leads.
    if(x.object==='listing' || (x.pricing && x.seller && x.payment)) continue;
    const title=String(x.title??x.name??x.service??x.subject??'').trim().slice(0,500);
    const description=String(x.description??x.descriptionText??x.summary??x.details??x.request??x.requirements??'').trim().slice(0,5000);
    const sourceUrl=String(x.url??x.href??x.listing_url??x.public_url??'').trim().slice(0,2000);
    if(!title && !description) continue;
    const providerId=x.id??x.listing_id??x.job_id??x.opportunity_id;
    const normalized=[title,description,sourceUrl].map(v=>v.toLowerCase().replace(/\s+/g,' ').trim()).join('|');
    const id=String(providerId??('content:'+normalized));
    if(seen.has(id)) continue;
    seen.add(id);
    out.push({id,title,description,source_url:sourceUrl});
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
  {source:'opentrain_public_jobs',url:'https://app.opentrain.ai/api/public/v1/jobs?q=software%20engineering&limit=50',provider:'OpenTrain Public Jobs'}
];

export async function scanAgentDemand(db,{fetcher=fetchJson,sources=DEFAULT_DEMAND_SOURCES}={}) {
  const budget=await checkBudget(db,{external_requests:sources.length});
  if(!budget.allowed) return {ok:false,blocked:budget.violations,signals:[]};
  const signals=[];
  const diagnostics=[];
  for(const s of sources){
    try {
      const r=await fetcher(s.url);
      if(!r.ok) {
        diagnostics.push({source:s.source,status:'HTTP_ERROR',http_status:r.status});
        await registerCapability(db,{capability_id:s.source,kind:'marketplace',provider:s.provider||s.source,protocol:'API',endpoint:s.url,cost_class:'free',risk:'medium',status:'DEGRADED',metadata:{http_status:r.status}});
        continue;
      }
      const listings=extractListings(r.text);
      const offersExcluded=countExcludedSupplyOffers(r.text);
      let accepted=0,duplicates=0,rejected=0;
      for(const lead of listings){
        const safe=sanitizeExternalInput(lead);
        const valid=validateMarketplaceLead(safe.data);
        if(!valid.ok) { rejected++; continue; }
        // The provider ID is preferred; content-derived IDs keep ID-less listings stable across scans.
        const key=s.source+'|'+lead.id;
        const exists=await db.prepare('SELECT id FROM demand_signals WHERE signal_key=?').first(key);
        if(exists) { duplicates++; continue; }
        const summary=String([lead.title,lead.description].filter(Boolean).join(' — ')).slice(0,3000);
        const score=Number((valid.score*0.7 + 0.3).toFixed(4));
        await db.prepare('INSERT INTO demand_signals(source,signal_key,request_summary,score,status) VALUES(?,?,?,?,?)')
          .bind(s.source,key,summary,score,'NEW').run();
        signals.push({source:s.source,id:lead.id,title:lead.title,score});
        accepted++;
      }
      diagnostics.push({source:s.source,status:'OK',http_status:r.status,content_type:r.contentType||null,listings_seen:listings.length,offers_excluded:offersExcluded,accepted,duplicates,rejected});
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
    const exists=await db.prepare('SELECT id FROM growth_actions WHERE action_key=?').first(key);
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
