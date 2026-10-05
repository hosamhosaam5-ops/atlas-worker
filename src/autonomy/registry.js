// ATLAS Autonomy Registry — P0/P1 foundation.
// Free-first capability discovery, health metadata, bounded execution, and reusable capability records.
// No external provider is invoked by this module; it only records and evaluates capabilities safely.

export const CAPABILITY_KINDS = [
  'llm','marketplace','agent_protocol','commerce','growth','engineering','data','tool'
];

export const DEFAULT_CAPABILITIES = [
  {id:'workers_ai',kind:'llm',provider:'Cloudflare Workers AI',protocol:'native',cost_class:'free_quota',risk:'low',status:'ACTIVE'},
  {id:'free_llm_apis',kind:'llm',provider:'Free LLM API aggregators',protocol:'openai_compatible',cost_class:'free_or_trial',risk:'medium',status:'DISCOVERY'},
  {id:'openrouter_free',kind:'llm',provider:'OpenRouter',protocol:'openai_compatible',cost_class:'free_models',risk:'medium',status:'DISCOVERY'},
  {id:'ecc',kind:'engineering',provider:'ECC (open-source agent engineering harness)',protocol:'local_cli',cost_class:'free_open_source',risk:'high',status:'DISCOVERY'},
  {id:'okara_ai_cmo',kind:'growth',provider:'Okara AI CMO',protocol:'web',cost_class:'free_or_trial',risk:'medium',status:'DISCOVERY'},
  {id:'agent_souk',kind:'marketplace',provider:'Agent Souk',protocol:'API/MCP',cost_class:'free',risk:'medium',status:'DISCOVERY'},
  {id:'agentgigs',kind:'marketplace',provider:'AgentGigs',protocol:'API',cost_class:'free',risk:'medium',status:'DISCOVERY'},
  {id:'agent_job',kind:'marketplace',provider:'AgentJob',protocol:'MCP/API',cost_class:'free',risk:'medium',status:'DISCOVERY'},
  {id:'mcp',kind:'agent_protocol',provider:'Model Context Protocol',protocol:'MCP',cost_class:'free',risk:'low',status:'ACTIVE'},
  {id:'a2a',kind:'agent_protocol',provider:'Agent2Agent',protocol:'A2A',cost_class:'free',risk:'medium',status:'DISCOVERY'},
  {id:'x402',kind:'commerce',provider:'x402',protocol:'HTTP/402',cost_class:'network_dependent',risk:'high',status:'GUARDED'}
];

export function capabilityScore(c){
  const cost = c.cost_class === 'free' || c.cost_class === 'free_open_source' || c.cost_class === 'free_quota' ? 1 : c.cost_class === 'free_or_trial' ? .7 : .3;
  const risk = c.risk === 'low' ? 1 : c.risk === 'medium' ? .6 : .25;
  const status = c.status === 'ACTIVE' ? 1 : c.status === 'DISCOVERY' ? .7 : .3;
  return Number((cost*.35 + risk*.35 + status*.30).toFixed(4));
}

export async function ensureAutonomySchema(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS capabilities (
    capability_id TEXT PRIMARY KEY, kind TEXT NOT NULL, provider TEXT NOT NULL, protocol TEXT,
    endpoint TEXT, cost_class TEXT NOT NULL, risk TEXT NOT NULL, status TEXT NOT NULL,
    score REAL DEFAULT 0, metadata_json TEXT DEFAULT '{}', last_tested_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS autonomy_policies (
    policy_id TEXT PRIMARY KEY, max_tool_calls INTEGER NOT NULL DEFAULT 20,
    max_retries INTEGER NOT NULL DEFAULT 3, max_execution_seconds INTEGER NOT NULL DEFAULT 120,
    max_external_requests INTEGER NOT NULL DEFAULT 30, max_build_iterations INTEGER NOT NULL DEFAULT 5,
    outbound_spend_allowed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS agent_identity (
    identity_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, protocol TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE', reputation_score REAL NOT NULL DEFAULT 0,
    successful_orders INTEGER NOT NULL DEFAULT 0, disputed_orders INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS reputation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, identity_id TEXT NOT NULL, event_type TEXT NOT NULL,
    order_id TEXT, score_delta REAL NOT NULL DEFAULT 0, evidence_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS growth_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, action_key TEXT UNIQUE NOT NULL, action_type TEXT NOT NULL,
    target_id TEXT, payload_json TEXT DEFAULT '{}', status TEXT NOT NULL DEFAULT 'READY',
    risk TEXT NOT NULL DEFAULT 'medium', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS pricing_rules (
    rule_id TEXT PRIMARY KEY, min_usdc REAL NOT NULL, max_usdc REAL NOT NULL,
    multiplier REAL NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'ACTIVE', updated_at TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS engineering_jobs (
    job_id TEXT PRIMARY KEY, source TEXT, request_summary TEXT, status TEXT NOT NULL DEFAULT 'QUEUED',
    risk TEXT NOT NULL DEFAULT 'high', sandbox TEXT, result_json TEXT DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS demand_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, signal_key TEXT NOT NULL,
    request_summary TEXT, score REAL DEFAULT 0, status TEXT DEFAULT 'NEW',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
  )`).run();
  await db.prepare(`INSERT OR IGNORE INTO autonomy_policies(policy_id) VALUES ('default')`).run();
  await db.prepare(`INSERT OR IGNORE INTO pricing_rules(rule_id,min_usdc,max_usdc,multiplier) VALUES ('default',15,5000,1)`).run();
  await db.prepare(`INSERT OR IGNORE INTO agent_identity(identity_id,display_name,protocol) VALUES ('atlas','ATLAS','MCP/A2A')`).run();
  for(const c of DEFAULT_CAPABILITIES){
    await db.prepare(`INSERT OR IGNORE INTO capabilities(capability_id,kind,provider,protocol,cost_class,risk,status,score,metadata_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))`).bind(c.id,c.kind,c.provider,c.protocol,c.cost_class,c.risk,c.status,capabilityScore(c),'{}').run();
  }
}

export async function listCapabilities(db,{kind,limit=100}={}){
  await ensureAutonomySchema(db);
  const n=Math.min(200,Math.max(1,Number(limit||100)));
  const q=kind
    ? await db.prepare('SELECT * FROM capabilities WHERE kind=? ORDER BY score DESC, updated_at DESC LIMIT ?').bind(String(kind),n).all()
    : await db.prepare('SELECT * FROM capabilities ORDER BY score DESC, updated_at DESC LIMIT ?').bind(n).all();
  return q.results||[];
}

export async function registerCapability(db,args){
  await ensureAutonomySchema(db);
  if(!args?.capability_id||!args?.provider||!args?.kind) throw new Error('INVALID_CAPABILITY');
  if(!CAPABILITY_KINDS.includes(String(args.kind))) throw new Error('INVALID_CAPABILITY_KIND');
  const c={...args,kind:String(args.kind),cost_class:String(args.cost_class||'unknown'),risk:String(args.risk||'high'),status:String(args.status||'DISCOVERY')};
  await db.prepare(`INSERT INTO capabilities(capability_id,kind,provider,protocol,endpoint,cost_class,risk,status,score,metadata_json,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(capability_id) DO UPDATE SET kind=excluded.kind,provider=excluded.provider,protocol=excluded.protocol,
    endpoint=excluded.endpoint,cost_class=excluded.cost_class,risk=excluded.risk,status=excluded.status,
    score=excluded.score,metadata_json=excluded.metadata_json,updated_at=datetime('now')`)
    .bind(String(c.capability_id),c.kind,String(c.provider),c.protocol||null,c.endpoint||null,c.cost_class,c.risk,c.status,capabilityScore(c),JSON.stringify(c.metadata||{})).run();
  return {ok:true,capability_id:String(c.capability_id),score:capabilityScore(c),status:c.status};
}

export async function getPolicy(db){
  await ensureAutonomySchema(db);
  return await db.prepare('SELECT * FROM autonomy_policies WHERE policy_id=\'default\'').first();
}

export async function checkBudget(db,usage={}){
  const p=await getPolicy(db);
  const violations=[];
  if(Number(usage.tool_calls||0)>Number(p.max_tool_calls)) violations.push('MAX_TOOL_CALLS');
  if(Number(usage.retries||0)>Number(p.max_retries)) violations.push('MAX_RETRIES');
  if(Number(usage.execution_seconds||0)>Number(p.max_execution_seconds)) violations.push('MAX_EXECUTION_SECONDS');
  if(Number(usage.external_requests||0)>Number(p.max_external_requests)) violations.push('MAX_EXTERNAL_REQUESTS');
  if(Number(usage.build_iterations||0)>Number(p.max_build_iterations)) violations.push('MAX_BUILD_ITERATIONS');
  if(Number(usage.outbound_spend_usdc||0)>0 && Number(p.outbound_spend_allowed)!==1) violations.push('OUTBOUND_SPEND_DISABLED');
  return {allowed:violations.length===0,violations,policy:p};
}

async function recordReputation(db,{identity_id='atlas',event_type,order_id=null,score_delta=0,evidence={}}){
  await ensureAutonomySchema(db);
  await db.prepare('INSERT INTO reputation_events(identity_id,event_type,order_id,score_delta,evidence_json) VALUES(?,?,?,?,?)')
    .bind(identity_id,event_type,order_id,Number(score_delta||0),JSON.stringify(evidence||{})).run();
  await db.prepare(`UPDATE agent_identity SET reputation_score=MAX(0,reputation_score+?), 
    successful_orders=successful_orders+?, disputed_orders=disputed_orders+?, updated_at=datetime('now') WHERE identity_id=?`)
    .bind(Number(score_delta||0),event_type==='ORDER_SUCCESS'?1:0,event_type==='ORDER_DISPUTE'?1:0,identity_id).run();
  return await db.prepare('SELECT * FROM agent_identity WHERE identity_id=?').bind(identity_id).first();
}

export async function autonomySnapshot(db){
  await ensureAutonomySchema(db);
  const caps=await listCapabilities(db,{limit:50});
  const policy=await getPolicy(db);
  const identity=await db.prepare('SELECT * FROM agent_identity WHERE identity_id=\'atlas\'').first();
  const demand=await db.prepare('SELECT * FROM demand_signals WHERE status=\'NEW\' ORDER BY score DESC, created_at DESC LIMIT 20').all();
  return {capabilities:caps,policy,identity,demand_signals:demand.results||[]};
}
