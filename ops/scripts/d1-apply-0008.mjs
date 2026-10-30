import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';

const mode=process.argv[2];
const env=process.env;
const summary=env.GITHUB_STEP_SUMMARY;
const output=env.GITHUB_OUTPUT;
const ACCOUNT_ID='c46718094ced1f5f75492f4c67c7d390';
const DATABASE_NAME='atlas_db';
const DATABASE_ID='a5a75faa-e800-4112-b67a-3c53d7b0d8d4';
const BASELINE_PATH='.d1-0008-preflight.json';
const HEALTH_URL='https://atlas-worker.hosamhosaam5.workers.dev/health';
const BASE_COLUMNS=[
  'id','scan_id','source','raw_count','raw_recent_count','accepted_count','rejected_count',
  'rejection_counts_json','duplicate_count','response_ms','http_status','source_status',
  'error_code','started_at','finished_at','created_at'
];
const ADDITIONS=[
  {name:'breaker_state',type:'TEXT'},
  {name:'consecutive_failures',type:'INTEGER'},
  {name:'cooldown_ms',type:'INTEGER'}
];

function fail(message){throw new Error(message);}

function runWrangler(args){
  const result=spawnSync('npx',['--no-install','wrangler',...args],{
    encoding:'utf8',env,maxBuffer:16*1024*1024
  });
  if(result.status!==0){
    const detail=String(result.stderr||result.stdout||result.error?.message||'Wrangler command failed')
      .trim().replace(/[a-f0-9]{32}/gi,'[redacted]');
    fail('Wrangler command failed: '+detail);
  }
  return String(result.stdout||'').trim();
}

function parseJson(text){
  const starts=[text.indexOf('{'),text.indexOf('[')].filter(i=>i>=0).sort((a,b)=>a-b);
  for(const start of starts){
    const end=text[start]==='{'?text.lastIndexOf('}'):text.lastIndexOf(']');
    if(end<start)continue;
    try{return JSON.parse(text.slice(start,end+1));}catch{}
  }
  fail('No complete JSON payload returned by Wrangler.');
}

function findResultRows(value,found=[]){
  if(Array.isArray(value)){
    for(const item of value)findResultRows(item,found);
  }else if(value&&typeof value==='object'){
    if(Array.isArray(value.results))found.push(value.results);
    for(const [key,item] of Object.entries(value))if(key!=='results')findResultRows(item,found);
  }
  return found;
}

function queryRows(sql){
  const raw=runWrangler(['d1','execute',DATABASE_NAME,'--remote','--command',sql,'--json']);
  const candidates=findResultRows(parseJson(raw));
  if(!candidates.length)fail('D1 query returned no result-set envelope.');
  return candidates[0];
}

async function resolveD1(){
  if(!env.CLOUDFLARE_API_TOKEN)fail('Missing CLOUDFLARE_API_TOKEN; refusing D1 operation.');
  const identityResult=spawnSync('npx',['--no-install','wrangler','whoami','--json'],{
    encoding:'utf8',env,maxBuffer:8*1024*1024
  });
  if(identityResult.status!==0)fail('Wrangler account identity lookup failed; refusing D1 operation.');
  const identity=parseJson(String(identityResult.stdout||'').trim());
  const accounts=Array.isArray(identity.accounts)?identity.accounts:
    (Array.isArray(identity.result?.accounts)?identity.result.accounts:[]);
  if(accounts.length!==1||String(accounts[0]?.id||'')!==ACCOUNT_ID){
    fail('Wrangler account is not the exact allowlisted ATLAS account; refusing operation.');
  }
  const api=async(path)=>{
    const response=await fetch('https://api.cloudflare.com/client/v4'+path,{
      headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'Content-Type':'application/json'}
    });
    const data=await response.json();
    if(!response.ok||data.success!==true){
      const messages=Array.isArray(data.errors)?data.errors.map(x=>x.message).join('; '):'';
      fail('Cloudflare API HTTP '+response.status+(messages?': '+messages:''));
    }
    return data.result;
  };
  const listed=await api('/accounts/'+ACCOUNT_ID+'/d1/database?name='+encodeURIComponent(DATABASE_NAME)+'&per_page=100');
  const matches=Array.isArray(listed)?listed.filter(x=>x.name===DATABASE_NAME&&x.uuid===DATABASE_ID):[];
  if(matches.length!==1)fail('Exact allowlisted production atlas_db was not returned.');
  const details=await api('/accounts/'+ACCOUNT_ID+'/d1/database/'+DATABASE_ID+'?fields=uuid,name,version');
  if(details?.uuid!==DATABASE_ID||details?.name!==DATABASE_NAME||details?.version!=='production'){
    fail('D1 identity/version mismatch; only production atlas_db is permitted.');
  }
  return {api};
}

async function readProductionHealth(){
  const response=await fetch(HEALTH_URL,{headers:{accept:'application/json','cache-control':'no-cache'}});
  if(response.status!==200)fail('Production /health returned HTTP '+response.status+'; refusing migration.');
  const body=await response.json();
  if(body?.ok!==true||body?.db!=='ok')fail('Production /health is not healthy; refusing migration.');
  return {git_sha:String(body.git_sha||''),observed_at:new Date().toISOString()};
}

function scalar(sql,key){
  const rows=queryRows(sql);
  if(rows.length!==1)fail('Expected one aggregate result row.');
  const value=Number(rows[0][key]);
  if(!Number.isSafeInteger(value)||value<0)fail('Invalid aggregate value returned by D1.');
  return value;
}

async function preflight(){
  await resolveD1();
  const health=await readProductionHealth();
  const scanInfo=queryRows('PRAGMA table_info(demand_scan_source_runs)');
  const baseNames=scanInfo.map(row=>String(row.name||''));
  if(baseNames.length!==BASE_COLUMNS.length||BASE_COLUMNS.some((name,index)=>baseNames[index]!==name)){
    fail('Preflight mismatch: demand_scan_source_runs must match the exact 16-column 0006 schema before 0008.');
  }
  const healthInfo=queryRows('PRAGMA table_info(demand_source_health)');
  const healthNames=healthInfo.map(row=>String(row.name||''));
  for(const name of ['source','state','consecutive_failures','cooldown_ms']){
    if(!healthNames.includes(name))fail('Preflight mismatch: demand_source_health is missing '+name+'.');
  }
  const scanRows=scalar('SELECT COUNT(*) AS n FROM demand_scan_source_runs','n');
  const maxId=scalar('SELECT COALESCE(MAX(id),0) AS n FROM demand_scan_source_runs','n');
  const healthRows=scalar('SELECT COUNT(*) AS n FROM demand_source_health','n');
  const demandRows=scalar('SELECT COUNT(*) AS n FROM demand_signals','n');
  if(ADDITIONS.some(item=>baseNames.includes(item.name)))fail('One or more 0008 columns already exist; refusing duplicate execution.');
  const baseline={
    database_id:DATABASE_ID,
    production_worker_sha:health.git_sha,
    production_health_observed_at:health.observed_at,
    base_columns:baseNames,
    scan_rows:scanRows,
    scan_max_id:maxId,
    health_rows:healthRows,
    demand_signals_rows:demandRows,
    preflight_at:new Date().toISOString()
  };
  writeFileSync(BASELINE_PATH,JSON.stringify(baseline),{mode:0o600});
  chmodSync(BASELINE_PATH,0o600);
  appendFileSync(summary,'## 0008 read-only production preflight — PASS\n\n');
  appendFileSync(summary,'- Exact production D1 database: **'+DATABASE_NAME+'**\n');
  appendFileSync(summary,'- Production Worker SHA observed (not changed by this schema-only run): **'+(health.git_sha||'missing')+'**\n');
  appendFileSync(summary,'- Existing demand_scan_source_runs columns: **16 / 16 exact**\n');
  appendFileSync(summary,'- Target 0008 columns absent: **3 / 3**\n');
  appendFileSync(summary,'- Existing scan rows: **'+scanRows+'**; highest row id: **'+maxId+'**\n');
  appendFileSync(summary,'- demand_source_health rows: **'+healthRows+'**; demand_signals rows: **'+demandRows+'\n');
  appendFileSync(summary,'- Migration allowlist: **migrations/0008_demand_scan_breaker_observability.sql only**\n');
}

async function capture(){
  const {api}=await resolveD1();
  const result=await api('/accounts/'+ACCOUNT_ID+'/d1/database/'+DATABASE_ID+'/time_travel/bookmark');
  const bookmark=String(result?.bookmark||'');
  if(!/^[a-f0-9-]{24,128}$/i.test(bookmark))fail('Cloudflare returned no valid D1 bookmark; refusing write.');
  const capturedAt=Date.now();
  const runId=String(env.GITHUB_RUN_ID||'');
  if(!runId)fail('GITHUB_RUN_ID is missing; refusing write.');
  appendFileSync(output,'d1_bookmark='+bookmark+'\n');
  appendFileSync(output,'d1_bookmark_captured_at_ms='+capturedAt+'\n');
  appendFileSync(output,'d1_bookmark_run_id='+runId+'\n');
  appendFileSync(summary,'\n## 0008 pre-write D1 bookmark\n\n- Captured in this workflow run: **'+runId+'**\n- Captured at UTC: **'+new Date(capturedAt).toISOString()+'\n- Bookmark: '+bookmark+'\n');
}

function guard(){
  const bookmark=String(env.D1_BOOKMARK||'');
  const capturedAt=Number(env.D1_BOOKMARK_CAPTURED_AT_MS||0);
  const capturedRun=String(env.D1_BOOKMARK_RUN_ID||'');
  const runId=String(env.GITHUB_RUN_ID||'');
  if(!bookmark||!capturedAt||!capturedRun||capturedRun!==runId)fail('No bookmark captured in this exact workflow run.');
  if(!/^[a-f0-9-]{24,128}$/i.test(bookmark))fail('Bookmark format invalid.');
  const age=Date.now()-capturedAt;
  if(age<0||age>=2*60*60*1000)fail('Same-run bookmark is not younger than two hours; refusing D1 write.');
  appendFileSync(summary,'- Same-run bookmark age: **'+Math.floor(age/1000)+' seconds — PASS**\n');
}

async function verify(){
  const baseline=JSON.parse(readFileSync(BASELINE_PATH,'utf8'));
  await resolveD1();
  const health=await readProductionHealth();
  if(health.git_sha!==baseline.production_worker_sha){
    fail('Production Worker SHA changed during schema-only 0008 execution; refusing same-state verification.');
  }
  const info=queryRows('PRAGMA table_info(demand_scan_source_runs)');
  const names=info.map(row=>String(row.name||''));
  if(names.length!==19||baseline.base_columns.some((name,index)=>names[index]!==name)){
    fail('Postflight mismatch: expected original 16 columns plus exactly three 0008 columns.');
  }
  for(const expected of ADDITIONS){
    const row=info.find(item=>item.name===expected.name);
    if(!row||String(row.type).toUpperCase()!==expected.type||Number(row.notnull)!==0||row.dflt_value!==null){
      fail('Postflight mismatch: '+expected.name+' must exist with nullable '+expected.type+' and no default.');
    }
  }
  const oldRows=scalar(
    'SELECT COUNT(*) AS n FROM demand_scan_source_runs WHERE id <= '+Number(baseline.scan_max_id),
    'n'
  );
  if(oldRows!==baseline.scan_rows)fail('Postflight mismatch: historical scan row count changed.');
  const oldNonNull=scalar(
    'SELECT COUNT(*) AS n FROM demand_scan_source_runs WHERE id <= '+Number(baseline.scan_max_id)+
    ' AND (breaker_state IS NOT NULL OR consecutive_failures IS NOT NULL OR cooldown_ms IS NOT NULL)',
    'n'
  );
  if(oldNonNull!==0)fail('Postflight mismatch: historical scan rows were backfilled or modified.');
  const scanRowsAfter=scalar('SELECT COUNT(*) AS n FROM demand_scan_source_runs','n');
  const healthRowsAfter=scalar('SELECT COUNT(*) AS n FROM demand_source_health','n');
  const demandRowsAfter=scalar('SELECT COUNT(*) AS n FROM demand_signals','n');
  if(scanRowsAfter<baseline.scan_rows||healthRowsAfter!==baseline.health_rows||demandRowsAfter!==baseline.demand_signals_rows){
    fail('Postflight mismatch: historical scan rows deleted or unrelated demand/health row counts changed.');
  }
  appendFileSync(summary,'\n## 0008 postflight — PASS\n\n');
  appendFileSync(summary,'- New nullable columns: breaker_state TEXT, consecutive_failures INTEGER, cooldown_ms INTEGER.\n');
  appendFileSync(summary,'- Historical scan rows retained: **'+oldRows+'**; historical values remain NULL.\n');
  appendFileSync(summary,'- Total scan rows after migration: **'+scanRowsAfter+'** (new rows during operation, if any, are preserved).\n');
  appendFileSync(summary,'- demand_source_health rows unchanged: **'+healthRowsAfter+'**; demand_signals rows unchanged: **'+demandRowsAfter+'**.\n');
  appendFileSync(summary,'- Production /health remained healthy at unchanged Worker SHA: **'+health.git_sha+'**.\n');
}

try{
  if(mode==='preflight')await preflight();
  else if(mode==='capture')await capture();
  else if(mode==='guard')guard();
  else if(mode==='verify')await verify();
  else fail('Unknown mode. Use preflight, capture, guard, or verify.');
}catch(error){
  console.error(String(error?.message||error));
  process.exit(1);
}
