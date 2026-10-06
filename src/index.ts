// Production verification: test suite green; deploy current main.
// ATLAS Worker — M2: Telegram webhook (receive + log only) + async CEO pipeline.
// The webhook NEVER runs CEO reasoning synchronously: it inserts into event_log
// (idempotency at DB level) and defers heavy processing via ctx.waitUntil.
// AI_PROVIDER=MOCK by default — zero external AI calls in M2.

// @ts-ignore — JS module without declaration file (Worker bundler resolves it)
import { processUpdate } from './ceo/pipeline.js';
// @ts-ignore
import { handleChatGptBridge } from './bridges/chatgpt.js';
// @ts-ignore
import { handleSiweBridge } from './bridges/siwe.js';
// @ts-ignore
import { handleBountyBookAuth } from './bridges/bountybook.js';
// @ts-ignore
import { ensureCommercialSchema, listProducts, upsertProduct, createQuote, requestFinancialApproval, decideFinancialApproval, listFinancialApprovals } from './commercial/control.js';
// @ts-ignore
import { runCommercialIntegration } from './commercial/testHarness.js';
// @ts-ignore
import { processOrder } from './orders/intake.js';
// @ts-ignore
import { ensureOrderSchema } from './orders/schema.js';
// @ts-ignore
import { runDailyReport } from './crons/dailyReport.js';
// @ts-ignore
import { runRevenueWatch } from './crons/revenueWatch.js';
// @ts-ignore
import { runTelegraphMonitor } from './crons/telegraphMonitor.js';
// @ts-ignore
import { getTelegramProvider } from './core/outbox.js';
// Autonomy foundation: capability registry, bounded execution, trust boundary, reputation.
// @ts-ignore
import { ensureAutonomySchema, listCapabilities, registerCapability, getPolicy, checkBudget, autonomySnapshot } from './autonomy/registry.js';
// @ts-ignore
import { sanitizeExternalInput, authorizeAction, validateMarketplaceLead } from './autonomy/policy.js';
// @ts-ignore
import { acquisitionCycle, discoverCapabilities, scanAgentDemand, selectLLMRoute } from './autonomy/engine.js';
// @ts-ignore
import { agentCard, createWebhook, listWebhooks, discoverAgentMarketplaces, prepareOffer, negotiateOffer, productIntelligence, x402Requirements, handleA2A } from './autonomy/p1.js';
// P2 growth: bounded acquisition intelligence, machine-readable discovery assets, referrals.
// @ts-ignore
import { ensureGrowthAssets, getGrowthAsset, runGrowthCycle, growthSnapshot, trackReferral } from './autonomy/p2.js';
// P3 trust + agent commerce lifecycle.
// @ts-ignore
import { commerceManifest, trustSnapshot, createCommerceSession, advanceCommerceSession, commerceSnapshot } from './autonomy/p3.js';
import OAuthProvider, { insufficientScope } from '@cloudflare/workers-oauth-provider';
import { handleAccessRequest } from './mcp/access-handler.ts';

interface Env {
  DB: D1Database;
  AI: Ai;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_MOCK_SCENARIO?: string;
  BRAVE?: string;
  TELEGRAM_PROVIDER?: string;
  EMAIL_PROVIDER?: string;
  EMAIL_MOCK_SCENARIO?: string;
  PAYMENT_MOCK_SCENARIO?: string;
  PAYMENT_PROVIDER?: string;
  OPENROUTER_API_KEY?: string;
  ORDER_WEBHOOK_SECRET?: string;
  RECOVERY_STALE_MINUTES?: string;
  PROCESS_SYNC?: string; // '1' for local tests: run pipeline inline and return its result
  DEV_MODE?: string;     // '1' for local tests only: enables /dev/* inspection endpoints. NEVER set in production.
  OAUTH_KV: KVNamespace;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_TOKEN_URL: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_JWKS_URL: string;
  OPENROUTER_FREE_MODEL?: string;
  GITHUB_MODELS_TOKEN?: string;
  GITHUB_MODELS_MODEL?: string;
  CHATGPT_BRIDGE_SECRET?: string;
  ATLAS_ORIGIN?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

async function handleAtlasMcp(request: Request, env: Env, ctx: ExecutionContext & { readonly auth?: { scope?: string[]; audience?: string } }) {
  const json=(data:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json",...headers}});
  if(request.method!=="POST")return json({jsonrpc:"2.0",error:{code:-32000,message:"Method Not Allowed"}},405,{Allow:"POST"});
  let msg:any;try{msg=await request.json();}catch{return json({jsonrpc:"2.0",error:{code:-32700,message:"Parse error"}},400);}
  const id=msg&&Object.prototype.hasOwnProperty.call(msg,"id")?msg.id:null;const result=(payload:any)=>json({jsonrpc:"2.0",id,...payload},200,{"MCP-Protocol-Version":"2025-03-26"});
  if(!msg||msg.jsonrpc!=="2.0")return result({error:{code:-32600,message:"Invalid Request"}});
  const authScopes=Array.isArray(ctx?.auth?.scope)?ctx.auth.scope:[];
  const requireScope=(scope:string)=>{
    if(authScopes.includes(scope)) return null;
    if(ctx?.auth?.audience) return insufficientScope(ctx.auth as any,[scope]);
    return json({jsonrpc:"2.0",id,error:{code:-32001,message:"insufficient_scope",required_scope:scope}},403,{"WWW-Authenticate":`Bearer error="insufficient_scope", scope="${scope}"`});
  };
  if(msg.method==="tools/list"){
    const denied=requireScope("mcp:read"); if(denied) return denied;
  }

  if(msg.method==="initialize")return result({result:{protocolVersion:"2025-03-26",capabilities:{tools:{listChanged:false}},serverInfo:{name:"ATLAS Cloudflare",version:"2.1.0"}}});
  if(msg.method==="notifications/initialized")return new Response(null,{status:202});
  if(msg.method==="ping")return result({result:{}});
  if(msg.method==="tools/list")return result({result:{tools:[
   {name:"health",description:"Read ATLAS Worker health and provider status.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{},additionalProperties:false}},
   {name:"read_state",description:"Read ATLAS execution state from D1.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{limit:{type:"integer",minimum:1,maximum:200}},additionalProperties:false}},
   {name:"read_tables",description:"Read ATLAS CEO memory and operational table counts.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{memory_limit:{type:"integer",minimum:1,maximum:100}},additionalProperties:false}},
   {name:"read_workflow_metadata",description:"Read ATLAS Worker and MCP metadata.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{},additionalProperties:false}},
   {name:"write_state",description:"Upsert up to 100 validated execution-state rows.",securitySchemes:[{type:"oauth2",scopes:["mcp:write"]}],inputSchema:{type:"object",properties:{rows:{type:"array",maxItems:100}},required:["rows"],additionalProperties:false}},
   {name:"write_memory",description:"Append up to 100 validated CEO memory rows.",securitySchemes:[{type:"oauth2",scopes:["mcp:write"]}],inputSchema:{type:"object",properties:{rows:{type:"array",maxItems:100}},required:["rows"],additionalProperties:false}},
   {name:"list_products",description:"List ATLAS products. Drafts require explicit include_drafts.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{include_drafts:{type:"boolean"}},additionalProperties:false}},
   {name:"upsert_product",description:"Create or update a product. Default status is DRAFT; no launch or payment occurs.",securitySchemes:[{type:"oauth2",scopes:["mcp:write"]}],inputSchema:{type:"object",properties:{product_id:{type:"string"},name:{type:"string"},description:{type:"string"},unit:{type:"string"},price_usdc:{type:"number"},pricing_mode:{type:"string"},status:{type:"string"}},required:["product_id","name","description"],additionalProperties:false}},
   {name:"create_quote",description:"Create a founder-controlled quote for an ACTIVE product or standalone client.",securitySchemes:[{type:"oauth2",scopes:["mcp:write"]}],inputSchema:{type:"object",properties:{client_email:{type:"string"},agreed_amount:{type:"number"},note:{type:"string"},product_id:{type:["string","null"]}},required:["client_email","agreed_amount"],additionalProperties:false}},
   {name:"request_financial_approval",description:"Create a PENDING founder financial approval record. It never moves funds.",securitySchemes:[{type:"oauth2",scopes:["mcp:write"]}],inputSchema:{type:"object",properties:{order_id:{type:["string","null"]},quote_id:{type:["integer","null"]},action:{type:"string"},amount_usdc:{type:["number","null"]},requested_by:{type:"string"},reason:{type:"string"}},required:["action"],additionalProperties:false}},
   {name:"decide_financial_approval",description:"Record a founder approval decision (APPROVED or REJECTED). This records authorization only; it never executes payment.",securitySchemes:[{type:"oauth2",scopes:["mcp:write"]}],inputSchema:{type:"object",properties:{approval_id:{type:"string"},status:{type:"string",enum:["APPROVED","REJECTED"]},decided_by:{type:"string"},reason:{type:"string"}},required:["approval_id","status","decided_by"],additionalProperties:false}},
   {name:"list_capabilities",description:"List ATLAS capability registry entries and health metadata.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{kind:{type:"string"},limit:{type:"integer",minimum:1,maximum:200}},additionalProperties:false}},
   {name:"autonomy_snapshot",description:"Read the bounded autonomy snapshot: capabilities, policy, identity, and demand signals.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{},additionalProperties:false}},
   {name:"get_autonomy_policy",description:"Read ATLAS autonomous execution guardrails.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{},additionalProperties:false}},
   {name:"check_autonomy_budget",description:"Check whether a proposed autonomous workload stays within ATLAS execution limits.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{tool_calls:{type:"integer"},retries:{type:"integer"},execution_seconds:{type:"number"},external_requests:{type:"integer"},build_iterations:{type:"integer"},outbound_spend_usdc:{type:"number"}},additionalProperties:false}},
   {name:"discover_capabilities",description:"Read-only discovery and health probe of configured free-first capabilities and agent-native services.",securitySchemes:[{type:"oauth2",scopes:["mcp:execute"]}],inputSchema:{type:"object",properties:{},additionalProperties:false}},
   {name:"scan_agent_demand",description:"Read-only scan for public agent-native demand signals; never applies, messages, pays, or creates an order.",securitySchemes:[{type:"oauth2",scopes:["mcp:execute"]}],inputSchema:{type:"object",properties:{},additionalProperties:false}},
   {name:"acquisition_cycle",description:"Run the bounded autonomous acquisition discovery cycle: capability discovery plus public demand scan.",securitySchemes:[{type:"oauth2",scopes:["mcp:execute"]}],inputSchema:{type:"object",properties:{},additionalProperties:false}},
   {name:"select_llm_route",description:"Select currently available free-first LLM routes without invoking a provider.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{preferFree:{type:"boolean"}},additionalProperties:false}},
   {name:"list_financial_approvals",description:"List financial approval records and lifecycle states.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{status:{type:["string","null"]},limit:{type:"integer"}},additionalProperties:false}},
   {name:"discover_agent_marketplaces",description:"Probe public agent marketplaces. Never authenticates, applies, messages, or spends.",securitySchemes:[{type:"oauth2",scopes:["mcp:execute"]}],inputSchema:{type:"object",properties:{},additionalProperties:false}},
   {name:"prepare_offer",description:"Prepare a bounded offer from a qualified demand signal. External sending is never attempted.",securitySchemes:[{type:"oauth2",scopes:["mcp:execute"]}],inputSchema:{type:"object",properties:{signal_id:{type:"integer"},price_usdc:{type:"number"},message:{type:"string"}},required:["signal_id"],additionalProperties:false}},
   {name:"negotiate_offer",description:"Calculate a bounded midpoint proposal; founder quote remains required.",securitySchemes:[{type:"oauth2",scopes:["mcp:execute"]}],inputSchema:{type:"object",properties:{action_key:{type:"string"},counter_price_usdc:{type:"number"}},required:["action_key","counter_price_usdc"],additionalProperties:false}},
   {name:"product_intelligence",description:"Read demand, product, and order signals to recommend reuse before building.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{},additionalProperties:false}},
   {name:"create_agent_webhook",description:"Register an HTTPS webhook for agent lifecycle events.",securitySchemes:[{type:"oauth2",scopes:["mcp:write"]}],inputSchema:{type:"object",properties:{agent_id:{type:"string"},url:{type:"string"},events:{type:"array"}},required:["agent_id","url"],additionalProperties:false}},
   {name:"list_agent_webhooks",description:"List registered agent webhooks.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{agent_id:{type:"string"}},additionalProperties:false}},
   {name:"growth_snapshot",description:"Read P2 growth runs, qualified actions, demand signals, partner discovery, and referral metrics.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{},additionalProperties:false}},
   {name:"run_growth_cycle",description:"Run the bounded P2 growth cycle: public demand discovery, lead preparation, A2A partner discovery, and machine-readable acquisition assets. No outbound messages, applications, purchases, or spending.",securitySchemes:[{type:"oauth2",scopes:["mcp:execute"]}],inputSchema:{type:"object",properties:{},additionalProperties:false}},
   {name:"trust_snapshot",description:"Read verified ATLAS service trust metrics derived from real order and reputation records; no customer PII is returned.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{},additionalProperties:false}},
   {name:"commerce_manifest",description:"Read the machine-readable ATLAS agent commerce lifecycle and payment safety contract.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{product_id:{type:"string"},price_usdc:{type:"number"}},additionalProperties:false}},
   {name:"commerce_snapshot",description:"Read agent commerce session stages and verified trust metrics.",securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}],inputSchema:{type:"object",properties:{},additionalProperties:false}},
   {name:"create_commerce_session",description:"Start an inbound agent commerce session at DISCOVER. No payment or outbound action occurs.",securitySchemes:[{type:"oauth2",scopes:["mcp:write"]}],inputSchema:{type:"object",properties:{agent_id:{type:"string"},product_id:{type:"string"}},additionalProperties:false}},
   {name:"advance_commerce_session",description:"Advance one bounded commerce lifecycle stage. This records state only and never sends funds.",securitySchemes:[{type:"oauth2",scopes:["mcp:write"]}],inputSchema:{type:"object",properties:{session_id:{type:"string"},stage:{type:"string"},quote_id:{type:["integer","null"]},payment_ref:{type:["string","null"]},order_id:{type:["string","null"]}},required:["session_id","stage"],additionalProperties:false}},
   {name:"run_commercial_integration",description:"Run a real D1-backed order/quote/payment-gate/QA/delivery/idempotency/recovery integration suite using only MOCK payment and email adapters. Defaults to the active commercial catalog product when product_id is omitted; an explicit product_id may target another ACTIVE product.",securitySchemes:[{type:"oauth2",scopes:["mcp:execute"]}],inputSchema:{type:"object",properties:{product_id:{type:"string"}},additionalProperties:false}},
   {name:"execute_ceo",description:"Execute an ATLAS CEO request through the authenticated production bridge.",securitySchemes:[{type:"oauth2",scopes:["mcp:execute"]}],inputSchema:{type:"object",properties:{founder_message:{type:"string",minLength:1,maxLength:20000},chat_id:{type:["string","number"]},message_id:{type:"integer"}},required:["founder_message","chat_id","message_id"],additionalProperties:false}}
  ]}});
  if(msg.method!=="tools/call")return result({error:{code:-32601,message:"Method not found"}});
  const name=msg.params?.name,args=msg.params?.arguments||{};let out:any;
  const requiredScopeByTool:any={
    health:"mcp:read",read_state:"mcp:read",read_tables:"mcp:read",read_workflow_metadata:"mcp:read",list_capabilities:"mcp:read",autonomy_snapshot:"mcp:read",get_autonomy_policy:"mcp:read",check_autonomy_budget:"mcp:read",select_llm_route:"mcp:read",
    discover_capabilities:"mcp:execute",scan_agent_demand:"mcp:execute",acquisition_cycle:"mcp:execute",trust_snapshot:"mcp:read",commerce_manifest:"mcp:read",commerce_snapshot:"mcp:read",create_commerce_session:"mcp:write",advance_commerce_session:"mcp:write",
    list_products:"mcp:read",list_financial_approvals:"mcp:read",list_capabilities:"mcp:read",autonomy_snapshot:"mcp:read",get_autonomy_policy:"mcp:read",check_autonomy_budget:"mcp:read",
    write_state:"mcp:write",write_memory:"mcp:write",upsert_product:"mcp:write",create_quote:"mcp:write",
    request_financial_approval:"mcp:write",decide_financial_approval:"mcp:write",
    run_commercial_integration:"mcp:execute",discover_agent_marketplaces:"mcp:execute",prepare_offer:"mcp:execute",negotiate_offer:"mcp:execute",product_intelligence:"mcp:read",create_agent_webhook:"mcp:write",list_agent_webhooks:"mcp:read",growth_snapshot:"mcp:read",run_growth_cycle:"mcp:execute",execute_ceo:"mcp:execute"
  };
  const requiredScope=requiredScopeByTool[name];
  if(!requiredScope)return result({error:{code:-32602,message:"Unknown tool"}});
  const denied=requiredScope==="mcp:read"?requireScope("mcp:read"):requireScope(requiredScope);
  if(denied)return denied;
  try{
   if(name==="health"){await ensureAutonomySchema(env.DB);let db="unknown";try{await env.DB.prepare("SELECT 1").first();db="ok";}catch{}out={ok:db==="ok",service:"atlas-worker",db,ai_provider:env.AI_PROVIDER||"MOCK",ai_model:env.AI_MODEL||null,telegram:env.TELEGRAM_PROVIDER||"MOCK"};}
   else if(name==="read_state"){const limit=Math.min(200,Math.max(1,Number(args.limit||50)));const q=await env.DB.prepare("SELECT idempotency_key,record_kind,correlation_id,request_id,entity_type,entity_id,action_id,tool,status,progress,error_code,attempt_count,delivery_state,message_key,expires_at,created_at,updated_at FROM execution_state ORDER BY updated_at DESC LIMIT ?").bind(limit).all();out={rows:q.results||[]};}
   else if(name==="read_tables"){const limit=Math.min(100,Math.max(1,Number(args.memory_limit||20)));const memory=await env.DB.prepare("SELECT id,category,content,created_at FROM ceo_memory ORDER BY id DESC LIMIT ?").bind(limit).all();const counts:any={};await ensureCommercialSchema(env.DB);for(const t of ["event_log","execution_state","ceo_memory","delivery_outbox","bridge_audit","products","financial_approvals","order_quotes","order_ledger","capabilities","agent_identity","reputation_events","demand_signals"]){try{const row:any=await env.DB.prepare("SELECT COUNT(*) AS count FROM "+t).first();counts[t]=Number(row?.count||0);}catch{counts[t]=null;}}const autonomy=await autonomySnapshot(env.DB);out={counts,ceo_memory:memory.results||[],autonomy:{capabilities:autonomy.capabilities,policy:autonomy.policy,identity:autonomy.identity,demand_signals:autonomy.demand_signals}};}
   else if(name==="list_capabilities"){out={capabilities:await listCapabilities(env.DB,args)};}
   else if(name==="autonomy_snapshot"){out=await autonomySnapshot(env.DB);}
   else if(name==="get_autonomy_policy"){out=await getPolicy(env.DB);}
   else if(name==="check_autonomy_budget"){out=await checkBudget(env.DB,args);}
   else if(name==="select_llm_route"){out={routes:selectLLMRoute(env,{preferFree:args.preferFree!==false})};}
   else if(name==="discover_capabilities"){out=await discoverCapabilities(env.DB);}
   else if(name==="scan_agent_demand"){out=await scanAgentDemand(env.DB);}
   else if(name==="acquisition_cycle"){out=await acquisitionCycle(env.DB);}
   else if(name==="read_workflow_metadata")out={service:"ATLAS Cloudflare Worker",bridge:"/bridge/chatgpt",mcp:"/mcp",mcp_mode:"READ_WRITE_EXECUTE",mcp_transport:"Streamable HTTP",auth:"OAuth 2.1 via Cloudflare Access"};
   else if(name==="write_state"){if(!Array.isArray(args.rows)||args.rows.length>100)throw new Error("INVALID_STATE_ROWS");let written=0;for(const row of args.rows){if(!row||!row.idempotency_key)throw new Error("INVALID_STATE_ROW");const payload=row.payload_json!==undefined?String(row.payload_json):JSON.stringify(row.payload??{});await env.DB.prepare("INSERT INTO execution_state (idempotency_key,record_kind,correlation_id,request_id,entity_type,entity_id,action_id,tool,status,progress,payload_json,error_code,attempt_count,delivery_state,message_key,chunk_index,expires_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(idempotency_key) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json,updated_at=datetime('now')").bind(String(row.idempotency_key),row.record_kind??null,row.correlation_id??null,row.request_id??null,row.entity_type??null,row.entity_id??null,row.action_id??null,row.tool??null,row.status??null,row.progress??null,payload,row.error_code??null,row.attempt_count??0,row.delivery_state??null,row.message_key??null,row.chunk_index??null,row.expires_at??null).run();written++;}out={written};}
   else if(name==="write_memory"){if(!Array.isArray(args.rows)||args.rows.length>100)throw new Error("INVALID_MEMORY_ROWS");for(const row of args.rows){if(!row||!String(row.content||"").trim())throw new Error("INVALID_MEMORY_ROW");await env.DB.prepare("INSERT INTO ceo_memory (category,content) VALUES (?,?)").bind(String(row.category||"fact"),String(row.content)).run();}out={written:args.rows.length};}
   else if(name==="list_products"){out={products:await listProducts(env.DB,args.include_drafts===true)};}
   else if(name==="upsert_product"){out=await upsertProduct(env.DB,args);}
   else if(name==="create_quote"){out=await createQuote(env.DB,args);}
   else if(name==="request_financial_approval"){out=await requestFinancialApproval(env.DB,args);}
   else if(name==="decide_financial_approval"){out=await decideFinancialApproval(env.DB,args);}
   else if(name==="list_financial_approvals"){out={approvals:await listFinancialApprovals(env.DB,args)};}
   else if(name==="discover_agent_marketplaces"){out=await discoverAgentMarketplaces(env.DB);}
   else if(name==="prepare_offer"){out=await prepareOffer(env.DB,args);}
   else if(name==="negotiate_offer"){out=await negotiateOffer(env.DB,args);}
   else if(name==="product_intelligence"){out=await productIntelligence(env.DB);}
   else if(name==="create_agent_webhook"){out=await createWebhook(env.DB,args);}
   else if(name==="list_agent_webhooks"){out={webhooks:await listWebhooks(env.DB,args)};}
   else if(name==="growth_snapshot"){out=await growthSnapshot(env.DB);}
   else if(name==="run_growth_cycle"){out=await runGrowthCycle(env.DB,new URL(request.url).origin);}
   else if(name==="trust_snapshot"){out=await trustSnapshot(env.DB);}
   else if(name==="commerce_manifest"){out=commerceManifest(new URL(request.url).origin,args);}
   else if(name==="commerce_snapshot"){out=await commerceSnapshot(env.DB);}
   else if(name==="create_commerce_session"){out=await createCommerceSession(env.DB,args);}
   else if(name==="advance_commerce_session"){out=await advanceCommerceSession(env.DB,args);}
   else if(name==="run_commercial_integration"){out=await runCommercialIntegration(env.DB,env,{product_id:args.product_id || "atlas_ai_data_qa_v1"});}
   else if(name==="execute_ceo"){const secret=env.CHATGPT_BRIDGE_SECRET;if(!secret)throw new Error("CHATGPT_BRIDGE_NOT_CONFIGURED");const r2=new Request(new URL("/bridge/chatgpt",request.url),{method:"POST",headers:{"content-type":"application/json","x-atlas-bridge-key":secret},body:JSON.stringify({operation:"execute_ceo",founder_message:args.founder_message,chat_id:args.chat_id,message_id:Number(args.message_id)})});const rr=await handleChatGptBridge(r2,env);const body=await rr.json();if(!rr.ok)throw new Error(String(body?.status||"EXECUTE_CEO_FAILED"));out=body;}
   else return result({error:{code:-32602,message:"Unknown tool"}});
  }catch(err:any){return result({result:{isError:true,content:[{type:"text",text:String(err?.message||err).slice(0,2000)}]}});}
  return result({result:{content:[{type:"text",text:JSON.stringify(out)}],structuredContent:out}});
}

const mcpOAuth = new OAuthProvider({
  resourceMetadata: { resource: "https://atlas-worker.hosamhosaam5.workers.dev/mcp", authorization_servers: ["https://atlas-worker.hosamhosaam5.workers.dev"], scopes_supported: ["mcp:read","mcp:write","mcp:execute"], bearer_methods_supported: ["header"], resource_name: "ATLAS MCP" },
  apiHandler: { fetch: handleAtlasMcp },
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: { fetch: handleAccessRequest as any },
  tokenEndpoint: "/token",
  scopesSupported: ["mcp:read","mcp:write","mcp:execute"],
  clientIdMetadataDocumentEnabled: true,
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    // Initialize additive autonomy tables on first request; migration remains the canonical schema artifact.
    try { await ensureAutonomySchema(env.DB); } catch (e) { console.error('AUTONOMY_SCHEMA_INIT_FAILED', String(e)); }
    const origin = new URL(request.url).origin;
    if (pathname === "/.well-known/agent-card.json") return new Response(JSON.stringify(agentCard(origin)),{headers:{"content-type":"application/json"}});
    if (pathname === "/catalog.json" && request.method === "GET") { await ensureGrowthAssets(env.DB,origin); const a=await getGrowthAsset(env.DB,"catalog.json"); return new Response(a?.content||"{}",{headers:{"content-type":"application/json","cache-control":"public, max-age=300"}}); }
    if (pathname === "/llms.txt" && request.method === "GET") { await ensureGrowthAssets(env.DB,origin); const a=await getGrowthAsset(env.DB,"llms.txt"); return new Response(a?.content||"# ATLAS",{headers:{"content-type":"text/plain; charset=utf-8","cache-control":"public, max-age=300"}}); }
    if (pathname === "/robots.txt" && request.method === "GET") return new Response("User-agent: *\nAllow: /\nAllow: /.well-known/\nAllow: /catalog.json\nAllow: /llms.txt\nDisallow: /dev/\nDisallow: /bridge/\nDisallow: /webhook/\n", {headers:{"content-type":"text/plain"}});
    if (pathname.startsWith("/r/") && request.method === "GET") { const code=decodeURIComponent(pathname.slice(3)).slice(0,100); await trackReferral(env.DB,{code,path:pathname,user_agent:request.headers.get("user-agent"),source:request.headers.get("referer")}); return Response.redirect(origin+"/catalog.json?ref="+encodeURIComponent(code),302); }
    if (pathname === "/a2a") return handleA2A(request,env);
    if (pathname === "/commerce.json" && request.method === "GET") return json(commerceManifest(origin));
    if (pathname === "/trust.json" && request.method === "GET") return json(await trustSnapshot(env.DB));
    if (request.method === "GET" && pathname === "/x402/atlas_ai_data_qa_v1") {
      const req=x402Requirements(origin,{wallet:"0xAC2Af2Dd2343F4EAab2de64C89129b7B9283666F",asset:"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"});
      const payload=JSON.stringify(req);
      const encoded=btoa(payload);
      return new Response(payload,{status:402,headers:{"content-type":"application/json","cache-control":"no-store","PAYMENT-REQUIRED":encoded}});
    }
    if (request.method === "GET" && pathname === "/.well-known/oauth-authorization-server") {
      return new Response(JSON.stringify({
        issuer: origin,
        authorization_endpoint: origin + "/authorize",
        token_endpoint: origin + "/token",
        registration_endpoint: origin + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code","refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp:read","mcp:write","mcp:execute"],
        protected_resources: [origin + "/mcp"],
        client_id_metadata_document_supported: true
      }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });
    }
    if (request.method === "GET" && (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp")) {
      return new Response(JSON.stringify({
        resource: "https://atlas-worker.hosamhosaam5.workers.dev/mcp",
        authorization_servers: [origin],
        scopes_supported: ["mcp:read","mcp:write","mcp:execute"],
        bearer_methods_supported: ["header"],
        resource_name: "ATLAS MCP"
      }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });
    }
    if (pathname === "/mcp" || pathname === "/authorize" || pathname === "/callback" || pathname === "/register" || pathname === "/token") return mcpOAuth.fetch(request, env, ctx);
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      let db = 'unknown';
      try {
        await env.DB.prepare('SELECT 1').first();
        db = 'ok';
      } catch (e) {
        db = 'error';
      }
      return json({ ok: true, service: 'atlas-worker', phase: 'M6', db, ai_provider: env.AI_PROVIDER || 'MOCK', brave: env.BRAVE || 'MOCK', telegram: env.TELEGRAM_PROVIDER || 'MOCK', email: env.EMAIL_PROVIDER || 'MOCK', payment: env.PAYMENT_PROVIDER || 'MOCK' });
    }

    // ---- M3 bridges (same contracts as backup workflows; MOCK adapters by default) ----
    if (url.pathname === '/bridge/chatgpt' && request.method === 'POST') {
      return handleChatGptBridge(request, env);
    }
    if (url.pathname === '/bridge/siwe') {
      return handleSiweBridge(request, env);
    }
    if (url.pathname === '/bridge/bountybook') {
      return handleBountyBookAuth(request, env);
    }

    // ---- M4 Order Intake (ports the n8n Form Trigger; multipart/form-data with file upload) ----
    if (url.pathname === '/webhook/order' && request.method === 'POST') {
      // Fail closed: this endpoint handles paid orders and must never be public by
      // accident. A missing secret disables the endpoint rather than bypassing auth.
      if (!env.ORDER_WEBHOOK_SECRET) {
        return json({ ok: false, error: 'ORDER_WEBHOOK_NOT_CONFIGURED' }, 503);
      }
      const suppliedSecret = request.headers.get('x-atlas-order-webhook-secret');
      if (suppliedSecret !== env.ORDER_WEBHOOK_SECRET) {
        return json({ ok: false, error: 'forbidden' }, 403);
      }
      const t0 = Date.now();
      await ensureCommercialSchema(env.DB);
      await ensureOrderSchema(env.DB);
      let input: any = {};
      const ct = request.headers.get('content-type') || '';
      try {
        if (ct.includes('multipart/form-data')) {
          const form = await request.formData();
          input.client_email = form.get('client_email');
          input.tx_hash = form.get('tx_hash');
          const file = form.get('file_upload');
          if (file && typeof file === 'object' && 'arrayBuffer' in file) {
            input.__file_name = (file as File).name;
            input.__file_bytes = new Uint8Array(await (file as File).arrayBuffer());
          }
        } else {
          // JSON test path (no real file possible — used only by local tests)
          const body: any = await request.json();
          input.client_email = body.client_email;
          input.tx_hash = body.tx_hash;
          if (body.file_base64) {
            input.__file_name = body.file_name || 'upload.csv';
            const bin = atob(body.file_base64);
            input.__file_bytes = Uint8Array.from(bin, (c: string) => c.charCodeAt(0));
          }
        }
      } catch {
        return json({ ok: false, error: 'bad request body' }, 400);
      }
      try {
        const result = await processOrder(env.DB, env, input);
        return json({ ok: true, ...result, webhook_latency_ms: Date.now() - t0 });
      } catch (e: any) {
        return json({ ok: false, error: String(e?.message || e) }, 500);
      }
    }

    if (url.pathname === '/webhook/telegram' && request.method === 'POST') {
      // Fail closed: Telegram webhook must have a configured secret in any deployed environment.
      if (!env.TELEGRAM_WEBHOOK_SECRET) {
        return json({ ok: false, error: 'TELEGRAM_WEBHOOK_NOT_CONFIGURED' }, 503);
      }
      const token = request.headers.get('x-telegram-bot-api-secret-token');
      if (token !== env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false, error: 'forbidden' }, 403);

      const t0 = Date.now();
      let update: any;
      try {
        update = await request.json();
      } catch {
        return json({ ok: false, error: 'bad json' }, 400);
      }

      const updateId = update?.update_id;
      if (updateId === undefined || updateId === null) {
        return json({ ok: false, error: 'missing update_id' }, 400);
      }
      // webhook only accepts message-bearing updates for CEO processing; others are ACKed
      const hasMessage = !!(update.message && typeof update.message.text === 'string');

      let eventPk: number | null = null;
      let status: 'ACCEPTED' | 'DUPLICATE' | 'IGNORED' | 'ERROR';
      let errorText: string | null = null;

      if (!hasMessage) {
        return json({ ok: true, status: 'IGNORED', update_id: updateId, latency_ms: Date.now() - t0 });
      }

      try {
        const res = await env.DB.prepare(
          "INSERT INTO event_log (source, external_id, payload_json, status) VALUES (?, ?, ?, 'PENDING')"
        )
          .bind('telegram', String(updateId), JSON.stringify(update))
          .run();
        eventPk = res.meta.last_row_id as number;
        status = 'ACCEPTED';
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.toLowerCase().includes('unique')) {
          status = 'DUPLICATE';
        } else {
          status = 'ERROR';
          errorText = msg;
        }
      }

      const latency = Date.now() - t0;

      if (status === 'ACCEPTED' && eventPk !== null) {
        const timings: Record<string, number> = {};
        const run = () => processUpdate(env, update, eventPk as number, timings)
          .then((result: any) => ({ result, timings }))
          .catch(async (err: any) => {
            // last-resort: never lose the event; record the failure
            try {
              await env.DB.prepare('UPDATE event_log SET status = ?, error = ? WHERE id = ?')
                .bind('PIPELINE_ERROR', String(err?.message || err), eventPk).run();
            } catch { /* nothing else to do */ }
            return { result: { outcome: 'PIPELINE_ERROR', error: String(err?.message || err) }, timings };
          });
        if (env.PROCESS_SYNC === '1') {
          // local test mode: run inline so tests can assert on the result
          const out = await run();
          return json({ ok: true, status, update_id: updateId, latency_ms: latency, pipeline: out.result, timings: out.timings });
        }
        // production shape: async — webhook returns immediately, heavy work continues
        ctx.waitUntil(run());
      }

      return json({ ok: true, status, update_id: updateId, error: errorText, latency_ms: latency });
    }

    // ---- local test/inspection endpoints (dev only, no secrets) ----
    // Production guard: /dev/* is reachable ONLY when DEV_MODE='1' is set explicitly.
    // DEV_MODE is never declared in wrangler.toml [vars], so a deployed Worker 404s these.
    if (url.pathname.startsWith('/dev/') && env.DEV_MODE !== '1') {
      return json({ ok: false, error: 'not found' }, 404);
    }
    // Dev-only inspection of order state (local tests)
    if (url.pathname === '/dev/orders' && request.method === 'GET') {
      await ensureOrderSchema(env.DB);
      const { results } = await env.DB.prepare('SELECT * FROM order_ledger ORDER BY created_at DESC LIMIT 50').all();
      const outbox = await env.DB.prepare('SELECT order_id, channel, status, attempts, last_error FROM delivery_outbox ORDER BY id DESC LIMIT 50').all();
      return json({ ok: true, ledger: results, outbox: outbox.results });
    }

    if (url.pathname === '/dev/state' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT idempotency_key, record_kind, request_id, entity_type, entity_id, status, progress, error_code, delivery_state FROM execution_state LIMIT 200').all();
      return json({ ok: true, rows: results });
    }
    if (url.pathname === '/dev/memory' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT id, category, content, created_at FROM ceo_memory ORDER BY id DESC LIMIT 50').all();
      return json({ ok: true, rows: results });
    }
    if (url.pathname === '/dev/events' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT id, source, external_id, status, error, created_at FROM event_log ORDER BY id DESC LIMIT 50').all();
      return json({ ok: true, rows: results });
    }
    if (url.pathname === '/dev/reset' && request.method === 'POST') {
      // local-only reset between test scenarios — never exposed in production config
      await env.DB.prepare('DELETE FROM event_log').run();
      await env.DB.prepare('DELETE FROM execution_state').run();
      await env.DB.prepare('DELETE FROM ceo_memory').run();
      await ensureOrderSchema(env.DB);
      await env.DB.prepare('DELETE FROM order_ledger').run();
      await env.DB.prepare('DELETE FROM order_quotes').run();
      await env.DB.prepare('DELETE FROM order_files').run();
      await env.DB.prepare('DELETE FROM delivery_outbox').run();
      return json({ ok: true, reset: true });
    }

    return json({ ok: false, error: 'not found' }, 404);
  },

  // M6A item 7/8: Cron entry point. Schedules are declared in wrangler.toml but stay
  // commented until the founder activates them at deploy. The handler runs all three
  // engines idempotently (each engine self-skips when there is nothing new).
  // alertAdapter bridges to the LIVE/MOCK telegram provider; MOCK sends nothing.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const tg = getTelegramProvider(env as any);
    const alertAdapter = {
      async send(chatId: string, text: string, _opts: any) {
        const res = await tg.send({ to: chatId, text });
        return res && res.ok ? { message_id: res.provider_message_id } : null;
      },
    };
    const run = async () => {
      const results: Record<string, unknown> = {};
      // Conservative recovery: never replay payment claims or CEO AI work blindly.
      // Flag stale nonterminal rows for explicit reconciliation rather than claiming success.
      try {
        const configuredStaleMinutes = Number(env.RECOVERY_STALE_MINUTES ?? 30);
        const staleMinutes = Number.isFinite(configuredStaleMinutes) ? Math.max(5, configuredStaleMinutes) : 30;
        const events = await env.DB.prepare("UPDATE event_log SET status='RECOVERY_REVIEW', error=COALESCE(error, 'Stale PENDING event requires safe review; automatic replay suppressed') WHERE status='PENDING' AND created_at < datetime('now', '-' || ? || ' minutes')").bind(staleMinutes).run();
        const orders = await env.DB.prepare("UPDATE order_ledger SET status='REVIEW_REQUIRED', error=COALESCE(error, 'Stale PENDING order requires payment/provider reconciliation'), updated_at=datetime('now') WHERE status='PENDING' AND created_at < datetime('now', '-' || ? || ' minutes')").bind(staleMinutes).run();
        // A stale SENDING outbox row is provider-outcome-ambiguous: never retry it automatically,
        // because the provider may already have accepted the message before the Worker crashed.
        const deliveries = await env.DB.prepare("UPDATE delivery_outbox SET status='REVIEW_REQUIRED', last_error=COALESCE(last_error, 'Stale SENDING delivery requires provider reconciliation; automatic retry suppressed'), updated_at=datetime('now') WHERE status='SENDING' AND COALESCE(updated_at, created_at) < datetime('now', '-' || ? || ' minutes')").bind(staleMinutes).run();
        results.recovery_sweep = { stale_minutes: staleMinutes, events_flagged: events.meta?.changes || 0, orders_flagged: orders.meta?.changes || 0, deliveries_flagged: deliveries.meta?.changes || 0 };
      } catch (e: any) { results.recovery_sweep = { error: String(e?.message || e) }; }
      for (const [name, fn] of [
        ['daily_report', () => runDailyReport(env, undefined, alertAdapter)],
        ['revenue_watch', () => runRevenueWatch(env, undefined, alertAdapter)],
        ['telegraph_monitor', () => runTelegraphMonitor(env, undefined, alertAdapter)],
        ['growth_cycle', () => runGrowthCycle(env.DB,env.ATLAS_ORIGIN || 'https://atlas-worker.hosamhosaam5.workers.dev')],
      ] as const) {
        try { results[name] = await fn(); }
        catch (e: any) { results[name] = { error: String(e?.message || e) }; }
      }
      return results;
    };
    ctx.waitUntil(run());
  },
};
