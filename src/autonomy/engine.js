// ATLAS Autonomous Company Engine — P0/P1/P2 execution layer.
// External discovery is read-only by default. Commercial actions remain policy-gated.
// No provider result is treated as trusted instruction.

import { registerCapability, listCapabilities, checkBudget } from './registry.js';
import { sanitizeExternalInput, validateMarketplaceLead, authorizeAction } from './policy.js';

const TIMEOUT_MS = 8000;

const PUBLIC_SOURCES = [
  {id:'agent_souk',kind:'marketplace',provider:'Agent Souk',protocol:'API/MCP/A2A',endpoint:'https://agentsouk.ai/v1/listings',cost_class:'free',risk:'medium'},
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
      const status=r.ok ? 'ACTIVE' : (r.status===401||r.status===403 ? 'AVAILABLE_AUTH_REQUIRED' : 'DEGRADED');
      const out=await registerCapability(db,{...s,status,metadata:{http_status:r.status,discovered:'public_probe'}});
      results.push({id:s.id,status,score:out.score,http_status:r.status});
    } catch(e) {
      const out=await registerCapability(db,{...s,status:'UNREACHABLE',metadata:{error:String(e?.message||e),discovered:'public_probe'}});
      results.push({id:s.id,status:'UNREACHABLE',score:out.score});
    }
  }
  return {ok:true,results};
}

function extractListings(payload){
  let data;
  try { data=JSON.parse(payload); } catch { return []; }
  const candidates=Array.isArray(data)?data:(Array.isArray(data?.listings)?data.listings:(Array.isArray(data?.results)?data.results:[]));
  return candidates.slice(0,50).map((x,i)=>({
    id:String(x.id??x.listing_id??x.job_id??i),
    title:String(x.title??x.name??x.service??''),
    description:String(x.description??x.summary??x.details??''),
    source_url:String(x.url??x.href??'')
  })).filter(x=>x.title||x.description);
}

export async function scanAgentDemand(db) {
  const budget=await checkBudget(db,{external_requests:1});
  if(!budget.allowed) return {ok:false,blocked:budget.violations};
  const sources=[{source:'agent_souk',url:'https://agentsouk.ai/v1/listings'}];
  const signals=[];
  for(const s of sources){
    try {
      const r=await fetchJson(s.url);
      if(!r.ok) { await registerCapability(db,{capability_id:s.source,kind:'marketplace',provider:'Agent Souk',protocol:'API',endpoint:s.url,cost_class:'free',risk:'medium',status:'DEGRADED',metadata:{http_status:r.status}}); continue; }
      for(const lead of extractListings(r.text)){
        const safe=sanitizeExternalInput(lead);
        const valid=validateMarketplaceLead(safe.data);
        if(!valid.ok) continue;
        const key=s.source+'|'+lead.id;
        const exists=await db.prepare('SELECT id FROM demand_signals WHERE signal_key=?').first(key);
        if(exists) continue;
        const score=Number((valid.score*0.7 + 0.3).toFixed(4));
        await db.prepare('INSERT INTO demand_signals(source,signal_key,request_summary,score,status) VALUES(?,?,?,?,?)')
          .bind(s.source,key,String(lead.title+' — '+lead.description).slice(0,3000),score,'NEW').run();
        signals.push({source:s.source,id:lead.id,title:lead.title,score});
      }
    } catch(e) { signals.push({source:s.source,error:String(e?.message||e)}); }
  }
  return {ok:true,signals};
}

export async function acquisitionCycle(db) {
  const discovery=await discoverCapabilities(db);
  const demand=await scanAgentDemand(db);
  return {ok:true,discovery,demand,next_action:'QUALIFY_AND_OFFER_REQUIRES_AUTHENTICATED_EXTERNAL_CHANNEL'};
}

export function selectLLMRoute(env,{preferFree=true}={}) {
  const routes=[];
  if(env.AI && typeof env.AI.run==='function') routes.push({provider:'WORKERS_AI',model:env.AI_MODEL||'@cf/zai-org/glm-4.7-flash',cost:'free_quota'});
  if(env.OPENROUTER_API_KEY) routes.push({provider:'OPENROUTER',model:env.OPENROUTER_FREE_MODEL||'openrouter/free',cost:'free_models'});
  if(env.GITHUB_MODELS_TOKEN) routes.push({provider:'GITHUB_MODELS',model:env.GITHUB_MODELS_MODEL||'openai/gpt-4o-mini',cost:'free_quota'});
  return preferFree ? routes.filter(x=>x.cost!=='paid') : routes;
}

export function buildAutonomousDecision(db,action,context={}) {
  return authorizeAction(action,context);
}
