import { checkBudget } from './registry.js';
import { sanitizeExternalInput } from './policy.js';
import { scanAgentDemand, prepareGrowthActions } from './engine.js';

async function ensureP2Schema(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS growth_runs (
    run_id TEXT PRIMARY KEY, status TEXT NOT NULL, signals_found INTEGER NOT NULL DEFAULT 0,
    actions_ready INTEGER NOT NULL DEFAULT 0, partner_signals INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT, detail_json TEXT DEFAULT '{}'
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS growth_assets (
    asset_id TEXT PRIMARY KEY, asset_type TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PUBLISHED',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS growth_referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, path TEXT,
    user_agent TEXT, source TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS growth_partners (
    partner_key TEXT PRIMARY KEY, name TEXT, endpoint TEXT, source TEXT,
    status TEXT NOT NULL DEFAULT 'DISCOVERED', metadata_json TEXT DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_growth_runs_started ON growth_runs(started_at DESC)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_growth_referrals_code ON growth_referrals(code,created_at)').run();
}

async function activeProducts(db){
  const q=await db.prepare("SELECT product_id,name,description,unit,price_usdc,pricing_mode,status,version FROM products WHERE status='ACTIVE' ORDER BY product_id").all();
  return q.results||[];
}

export async function buildCatalog(db,origin){
  await ensureP2Schema(db);
  const products=await activeProducts(db);
  return {
    schema_version:'atlas.catalog.v1',
    provider:'ATLAS',
    audience:'AI agents and agent systems',
    discovery:{agent_card:origin+'/.well-known/agent-card.json',a2a:origin+'/a2a',mcp:origin+'/mcp',x402:origin+'/x402/atlas_ai_data_qa_v1'},
    products:products.map(p=>({
      id:p.product_id,name:p.name,description:p.description,unit:p.unit,price_usdc:p.price_usdc,
      pricing_mode:p.pricing_mode,status:p.status,version:p.version,
      order_endpoint:origin+'/webhook/order',payment_protocol:'Base USDC / x402 requirements'
    }))
  };
}

export async function ensureGrowthAssets(db,origin){
  await ensureP2Schema(db);
  const catalog=await buildCatalog(db,origin);
  const llms=[
    '# ATLAS',
    '',
    'ATLAS provides machine-readable data QA and transformation services for AI agents.',
    '',
    '## Discovery',
    '- Agent Card: '+origin+'/.well-known/agent-card.json',
    '- A2A: '+origin+'/a2a',
    '- MCP: '+origin+'/mcp',
    '- Catalog: '+origin+'/catalog.json',
    '- x402 payment requirements: '+origin+'/x402/atlas_ai_data_qa_v1',
    '',
    '## Commercial rule',
    'Only active products and verified payment requirements are authoritative. Founder quote is required where pricing mode is FOUNDER_QUOTE.',
    '',
    '## Current product',
    ...catalog.products.map(p=>'- '+p.id+': '+p.name+' — '+p.price_usdc+' USDC; '+p.description)
  ].join('\n');
  const assets=[
    ['catalog','catalog.json','ATLAS machine-readable service catalog',JSON.stringify(catalog,null,2)],
    ['llms','llms.txt','ATLAS machine-readable discovery guide',llms]
  ];
  for(const [type,slug,title,content] of assets){
    await db.prepare("INSERT INTO growth_assets(asset_id,asset_type,slug,title,content,status,updated_at) VALUES(?,?,?,?,?,'PUBLISHED',datetime('now')) ON CONFLICT(slug) DO UPDATE SET title=excluded.title,content=excluded.content,status='PUBLISHED',updated_at=datetime('now')")
      .bind('asset_'+type, type, slug, title, content).run();
  }
  return {ok:true,assets:assets.map(x=>({asset_type:x[0],slug:x[1],status:'PUBLISHED'}))};
}

export async function getGrowthAsset(db,slug){
  await ensureP2Schema(db);
  return await db.prepare("SELECT asset_type,slug,title,content,status,updated_at FROM growth_assets WHERE slug=? AND status='PUBLISHED'").bind(String(slug)).first();
}

async function discoverPartners(db){
  const budget=await checkBudget(db,{external_requests:1});
  if(!budget.allowed)return {ok:false,partners:[],blocked:budget.violations};
  const url='https://api.a2a-registry.org/public/agents?q=data&target=Business';
  try{
    const r=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)});
    if(!r.ok)return {ok:true,partners:[],status:'DEGRADED',http_status:r.status};
    const body=await r.json().catch(()=>({}));
    const rows=Array.isArray(body)?body:(Array.isArray(body.agents)?body.agents:(Array.isArray(body.results)?body.results:[]));
    const partners=[];
    for(const x of rows.slice(0,10)){
      const safe=sanitizeExternalInput(x).data;
      const key=String(safe.identifier||safe.id||safe.name||crypto.randomUUID()).slice(0,200);
      const name=String(safe.name||safe.title||key).slice(0,200);
      const endpoint=String(safe.url||safe.endpoint||safe.manifestUrl||'').slice(0,1000);
      await db.prepare("INSERT INTO growth_partners(partner_key,name,endpoint,source,status,metadata_json,updated_at) VALUES(?,?,?,?,?,?,datetime('now')) ON CONFLICT(partner_key) DO UPDATE SET name=excluded.name,endpoint=excluded.endpoint,metadata_json=excluded.metadata_json,updated_at=datetime('now')")
        .bind(key,name,endpoint,'A2A_REGISTRY','DISCOVERED',JSON.stringify({source:'public'})).run();
      partners.push({key,name,endpoint});
    }
    return {ok:true,partners,http_status:r.status};
  }catch(e){return {ok:true,partners:[],status:'UNREACHABLE',error:String(e?.message||e)}}
}

export async function runGrowthCycle(db,origin){
  await ensureP2Schema(db);
  const runId='growth_'+crypto.randomUUID().replaceAll('-','').slice(0,20);
  await db.prepare("INSERT INTO growth_runs(run_id,status) VALUES(?,?)").bind(runId,'RUNNING').run();
  try{
    const demand=await scanAgentDemand(db);
    const growth=await prepareGrowthActions(db);
    const partners=await discoverPartners(db);
    await ensureGrowthAssets(db,origin);
    const signals=Array.isArray(demand?.signals)?demand.signals.filter(x=>!x.error):[];
    const actions=Array.isArray(growth?.actions)?growth.actions:[];
    await db.prepare("UPDATE growth_runs SET status='COMPLETED',signals_found=?,actions_ready=?,partner_signals=?,finished_at=datetime('now'),detail_json=? WHERE run_id=?")
      .bind(signals.length,actions.length,partners.partners?.length||0,JSON.stringify({demand,growth,partners}),runId).run();
    return {ok:true,run_id:runId,status:'COMPLETED',signals_found:signals.length,actions_ready:actions.length,partners_discovered:partners.partners?.length||0,assets:'PUBLISHED',external_outreach:'NOT_ATTEMPTED',outbound_spend_usdc:0};
  }catch(e){
    await db.prepare("UPDATE growth_runs SET status='FAILED',finished_at=datetime('now'),detail_json=? WHERE run_id=?").bind(JSON.stringify({error:String(e?.message||e)}),runId).run();
    return {ok:false,run_id:runId,status:'FAILED',error:String(e?.message||e),outbound_spend_usdc:0};
  }
}

export async function growthSnapshot(db){
  await ensureP2Schema(db);
  const [runs,actions,signals,partners,refs]=await Promise.all([
    (async()=>await db.prepare("SELECT run_id,status,signals_found,actions_ready,partner_signals,started_at,finished_at FROM growth_runs ORDER BY started_at DESC LIMIT 20").all())(),
    (async()=>await db.prepare("SELECT action_type,status,risk,COUNT(*) count FROM growth_actions GROUP BY action_type,status,risk ORDER BY count DESC").all())(),
    (async()=>await db.prepare("SELECT source,status,COUNT(*) count,AVG(score) avg_score FROM demand_signals GROUP BY source,status ORDER BY count DESC").all())(),
    (async()=>await db.prepare("SELECT source,status,COUNT(*) count FROM growth_partners GROUP BY source,status").all())(),
    (async()=>await db.prepare("SELECT code,COUNT(*) count,MAX(created_at) last_seen FROM growth_referrals GROUP BY code ORDER BY count DESC LIMIT 20").all())()
  ]);
  return {ok:true,runs:runs.results||[],actions:actions.results||[],signals:signals.results||[],partners:partners.results||[],referrals:refs.results||[]};
}

export async function trackReferral(db,{code,path,user_agent,source}={}){
  await ensureP2Schema(db);
  const c=String(code||'').trim().slice(0,100);
  if(!c)return {ok:false,error:'INVALID_REFERRAL_CODE'};
  const safe=sanitizeExternalInput({code:c,path,user_agent,source}).data;
  await db.prepare("INSERT INTO growth_referrals(code,path,user_agent,source) VALUES(?,?,?,?)")
    .bind(String(safe.code),String(safe.path||'').slice(0,500),String(safe.user_agent||'').slice(0,500),String(safe.source||'').slice(0,200)).run();
  return {ok:true,code:c};
}
