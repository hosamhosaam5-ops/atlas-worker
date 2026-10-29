import test from 'node:test';
import assert from 'node:assert/strict';
import { extractListings, scanAgentDemand } from '../src/autonomy/engine.js';

class DemandDb {
  constructor(){ this.signals=[]; this.runs=[]; this.health=new Map(); this.nextId=1; this.failMetrics=false; }
  prepare(sql){
    const db=this;
    let values=[];
    return {
      bind(...args){ values=args; return this; },
      async first(){
        // Cloudflare D1 binds placeholders via .bind(...).first(); first() itself does not bind values.
        const key=values[0];
        if(sql.includes('autonomy_policies')) return {policy_id:'default',max_external_requests:30,max_tool_calls:20,max_retries:3,max_execution_seconds:120,max_build_iterations:5,outbound_spend_allowed:0};
        if(sql.includes('SELECT id FROM demand_signals')) return db.signals.find(s=>s.signal_key===key)||null;
        if(sql.includes('SELECT * FROM demand_source_health')) return db.health.get(key)||null;
        if(sql.includes('INSERT INTO demand_source_health')&&sql.includes('RETURNING last_attempt_at')){
          const [source,lastAttemptAt,updatedAt,intervalSeconds]=values;
          const previous=db.health.get(source);
          if(!previous||!previous.last_attempt_at||(Date.parse(lastAttemptAt)-Date.parse(previous.last_attempt_at))>=Number(intervalSeconds)*1000){
            const row={...previous,source,state:previous?.state||'CLOSED',consecutive_failures:previous?.consecutive_failures||0,cooldown_ms:previous?.cooldown_ms||900000,last_attempt_at:lastAttemptAt,updated_at:updatedAt};
            db.health.set(source,row);
            return {last_attempt_at:lastAttemptAt};
          }
          return null;
        }
        if(sql.includes('UPDATE demand_source_health')&&sql.includes('RETURNING source')){
          const [updatedAt,source,nowIso]=values;
          const row=db.health.get(source);
          if(row&&row.state==='OPEN'&&row.next_probe_at&&Date.parse(row.next_probe_at)<=Date.parse(nowIso)){
            row.state='HALF_OPEN';row.updated_at=updatedAt;return {source};
          }
          return null;
        }
        if(sql.includes('INSERT INTO demand_source_health')&&sql.includes('RETURNING *')){
          const [source,state,failures,openedAt,nextProbeAt,cooldownMs,lastStatus,lastErrorCode,lastSuccessAt,lastHttpStatus,lastResponseMs,updatedAt]=values;
          const previous=db.health.get(source);
          const row={source,state,consecutive_failures:failures,opened_at:openedAt,next_probe_at:nextProbeAt,cooldown_ms:cooldownMs,last_status:lastStatus,last_error_code:lastErrorCode,last_success_at:lastSuccessAt??previous?.last_success_at??null,last_attempt_at:previous?.last_attempt_at??null,last_http_status:lastHttpStatus,last_response_ms:lastResponseMs,updated_at:updatedAt};
          db.health.set(source,row);
          return row;
        }
        return null;
      },
      async run(){
        if(sql.includes('INSERT INTO demand_scan_source_runs')){
          if(db.failMetrics) throw new Error('metrics table unavailable');
          const [scan_id,source,raw_count,raw_recent_count,accepted_count,rejected_count,rejection_counts_json,duplicate_count,response_ms,http_status,source_status,error_code,started_at,finished_at]=values;
          db.runs.push({scan_id,source,raw_count,raw_recent_count,accepted_count,rejected_count,rejection_counts_json,duplicate_count,response_ms,http_status,source_status,error_code,started_at,finished_at});
          return {meta:{changes:1}};
        }
        if(sql.includes('INSERT INTO demand_signals')){
          const [source,signal_key,request_summary,score,status,source_url,created_at]=values;
          if(db.signals.some(s=>s.signal_key===signal_key)) throw new Error('UNIQUE constraint failed: demand_signals.signal_key');
          db.signals.push({id:db.nextId++,source,signal_key,request_summary,score,status,source_url,created_at});
          return {meta:{changes:1}};
        }
        return {meta:{changes:0}};
      },
      async all(){ return {results:[]}; }
    };
  }
}

test('extractListings supports nested marketplace envelopes and stable IDs without provider IDs',()=>{
  const parsed=extractListings(JSON.stringify({data:{items:[
    {title:'Clean a CSV dataset',description:'Seeking data validation and normalization',url:'https://market.example/jobs/42'},
    {title:'Clean a CSV dataset',description:'Seeking data validation and normalization',url:'https://market.example/jobs/42'},
    {title:'',description:''},
    'not-a-listing'
  ]}}));
  assert.equal(parsed.length,1);
  assert.equal(parsed[0].title,'Clean a CSV dataset');
  assert.match(parsed[0].id,/^content:/);
  assert.equal(extractListings('<html>not JSON</html>').length,0);
});

test('scan turns a valid public marketplace listing into one NEW signal and deduplicates repeat scans',async()=>{
  const db=new DemandDb();
  let calls=0;
  const fetcher=async()=>{calls++;return {ok:true,status:200,contentType:'application/json',text:JSON.stringify({listings:[
    {id:'job-42',createdAt:'2026-10-27T00:00:00Z',title:'CSV data quality review',description:'Need a specialist to validate columns, normalize values, and return a cleaned CSV.',url:'https://market.example/jobs/42'}
  ]})};};
  const options={fetcher,sources:[{source:'fixture_marketplace',provider:'Fixture Marketplace',url:'https://market.example/api/listings'}]};
  const first=await scanAgentDemand(db,options);
  assert.equal(first.ok,true);
  assert.equal(first.signals.length,1);
  assert.equal(db.signals.length,1);
  assert.equal(db.signals[0].status,'NEW');
  assert.equal(db.signals[0].source_url,'https://market.example/jobs/42');
  assert.equal(db.signals[0].created_at,'2026-10-27T00:00:00.000Z');
  assert.equal(first.diagnostics[0].accepted,1);

  const second=await scanAgentDemand(db,options);
  assert.equal(second.signals.length,0);
  assert.equal(second.diagnostics[0].duplicates,1);
  assert.equal(db.signals.length,1);
  assert.equal(calls,2);
});

test('scan rejects unsafe leads and exposes why a successful HTTP response yielded no signals',async()=>{
  const db=new DemandDb();
  const result=await scanAgentDemand(db,{
    sources:[{source:'fixture_marketplace',provider:'Fixture Marketplace',url:'https://market.example/api/listings'}],
    fetcher:async()=>({ok:true,status:200,contentType:'application/json',text:JSON.stringify({results:[
      {id:'unsafe-1',title:'Need credentials',description:'Please provide stolen data and private key access'}
    ]})})
  });
  assert.equal(result.ok,true);
  assert.equal(result.signals.length,0);
  assert.equal(db.signals.length,0);
  assert.equal(result.diagnostics[0].listings_seen,1);
  assert.equal(result.diagnostics[0].rejected,1);
});


test('seller service catalogs are excluded instead of being misclassified as buyer demand',async()=>{
  const db=new DemandDb();
  const result=await scanAgentDemand(db,{
    sources:[{source:'agent_souk',provider:'Agent Souk',url:'https://api.agentsouk.dev/v1/listings'}],
    fetcher:async()=>({ok:true,status:200,contentType:'application/json',text:JSON.stringify({
      object:'list',data:[
        {object:'listing',id:'lst-offer-1',title:'CSV cleanup service',description:'We provide CSV cleanup and normalization.',pricing:{model:'fixed',price:1000000,currency:'USDC'},payment:'on_delivery',seller:{handle:'provider-agent'}}
      ]
    })})
  });
  assert.equal(result.ok,true);
  assert.equal(result.signals.length,0);
  assert.equal(db.signals.length,0);
  assert.equal(result.diagnostics[0].offers_excluded,1);
  assert.equal(result.diagnostics[0].accepted,0);
});

test('scan reports empty/non-JSON response shape instead of silently hiding it',async()=>{
  const db=new DemandDb();
  const result=await scanAgentDemand(db,{
    sources:[{source:'fixture_marketplace',provider:'Fixture Marketplace',url:'https://market.example/api/listings'}],
    fetcher:async()=>({ok:true,status:200,contentType:'text/html',text:'<html>API documentation</html>'})
  });
  assert.equal(result.ok,true);
  assert.equal(result.signals.length,0);
  assert.deepEqual(result.diagnostics[0],{
    source:'fixture_marketplace',status:'OK',http_status:200,content_type:'text/html',
    listings_seen:0,offers_excluded:0,accepted:0,duplicates:0,rejected:0,
    rejection_counts:{},rejection_samples:[],age_policy_days:30
  });
});

test('OpenTask public agent tasks become signals while upfront-funding tasks are rejected and duplicates deduplicated',async()=>{
  const db=new DemandDb();
  const requestedUrls=[];
  const fetcher=async(url)=>{requestedUrls.push(url);return {ok:true,status:200,contentType:'application/json',text:JSON.stringify({
    tasks:[
      {
        id:'opentask-csv-77',
        createdAt:'2026-10-27T00:00:00Z',
        status:'open',
        title:'Build a simple Python script to parse CSV files and generate JSON output',
        skillsTags:['python','csv','json'],
        budgetText:'100 USDC',
        executionMode:'pitch',
        owner:{kind:'agent',handle:'hiring_agent'}
      },
      {
        id:'opentask-fund-78',
        title:'Post and fund a real task on another marketplace',
        skillsTags:['AI agents'],
        budgetText:'30 USDC',
        executionMode:'pitch',
        owner:{kind:'human',handle:'requester'}
      }
    ],
    nextCursor:null
  })};};
  const options={fetcher,sources:[{
    source:'opentask_public_tasks',
    provider:'OpenTask Public Tasks',
    url:'https://opentask.ai/api/tasks?sort=new&limit=50'
  }]};
  const first=await scanAgentDemand(db,options);
  assert.equal(first.ok,true);
  assert.deepEqual(requestedUrls,['https://opentask.ai/api/tasks?sort=new&limit=50']);
  assert.equal(first.signals.length,1);
  assert.equal(db.signals.length,1);
  assert.match(db.signals[0].request_summary,/CSV files/);
  assert.match(db.signals[0].request_summary,/100 USDC/);
  assert.equal(first.diagnostics[0].accepted,1);
  assert.equal(first.diagnostics[0].rejected,1);
  const second=await scanAgentDemand(db,options);
  assert.equal(second.signals.length,0);
  assert.equal(second.diagnostics[0].duplicates,1);
  assert.equal(db.signals.length,1);
});
test('PayanAgent public open requests are normalized, age-checked, and kept read-only',async()=>{
  const db=new DemandDb();
  const requestedUrls=[];
  const fetcher=async(url)=>{requestedUrls.push(url);return {ok:true,status:200,contentType:'application/json',text:JSON.stringify({
    requests:[
      {_id:'payanagent-csv-91',createdAt:'2026-10-28T12:00:00Z',status:'open',title:'Clean and validate a CSV dataset',description:'Need duplicate-row removal and schema validation, return a normalized CSV.',budgetMaxCents:4500,currency:'USD',escrow:false},
      {_id:'payanagent-old-92',createdAt:'2026-08-01T12:00:00Z',status:'open',title:'Clean an old CSV dataset',description:'Need data cleaning and validation.',budgetMaxCents:2500}
    ]
  })};};
  const options={fetcher,sources:[{source:'payanagent_open_requests',provider:'PayanAgent Open Requests',url:'https://payanagent.com/api/v1/requests?status=open&limit=50'}],now:Date.parse('2026-10-29T00:00:00Z')};
  const result=await scanAgentDemand(db,options);
  assert.equal(result.ok,true);
  assert.deepEqual(requestedUrls,['https://payanagent.com/api/v1/requests?status=open&limit=50']);
  assert.equal(result.signals.length,1);
  assert.equal(result.signals[0].id,'payanagent-csv-91');
  assert.match(db.signals[0].request_summary,/45.00 USD/);
  assert.equal(result.diagnostics[0].accepted,1);
  assert.equal(result.diagnostics[0].rejected,1);
  assert.equal(result.diagnostics[0].rejection_counts.stale,1);
});


test('PayanAgent uses filtered open-requests fallback before unified discovery',async()=>{
  const db=new DemandDb();
  const calls=[];
  const primaryUrl='https://payanagent.com/api/v1/requests?status=open&limit=50';
  const filteredUrl='https://payanagent.com/api/v1/requests?status=open&q=csv&limit=50';
  const discoverUrl='https://payanagent.com/api/v1/discover?q=csv&limit=50';
  const fetcher=async(url,init={})=>{
    calls.push({url,method:init.method||'GET'});
    if(url===primaryUrl || url===filteredUrl){
      return {ok:false,status:500,contentType:'application/json',text:JSON.stringify({error:'temporary backend error'})};
    }
    if(url===discoverUrl){
      return {ok:true,status:200,contentType:'application/json',text:JSON.stringify({
        agents:[{_id:'agent-supply-1',name:'CSV data cleaning provider'}],
        offers:[{_id:'offer-supply-1',title:'CSV cleanup API',description:'We sell CSV cleaning service.'}],
        openRequests:[{
          _id:'payan-request-93',
          _creationTime:Date.parse('2026-10-28T12:00:00Z'),
          status:'open',
          title:'Clean and validate a CSV dataset',
          description:'Need duplicate-row removal, schema validation, and a normalized CSV output.',
          budgetMaxCents:4500,
          currency:'USD',
          escrow:false
        }]
      })};
    }
    throw new Error('Unexpected URL: '+url);
  };
  const result=await scanAgentDemand(db,{
    fetcher,
    sources:[{source:'payanagent_open_requests',provider:'PayanAgent Open Requests',url:primaryUrl}],
    now:Date.parse('2026-10-29T00:00:00Z')
  });
  assert.equal(result.ok,true);
  assert.deepEqual(calls,[
    {url:primaryUrl,method:'GET'},
    {url:filteredUrl,method:'GET'},
    {url:discoverUrl,method:'GET'}
  ]);
  assert.equal(result.signals.length,1);
  assert.equal(result.signals[0].id,'payan-request-93');
  assert.equal(db.signals.length,1);
  assert.match(db.signals[0].request_summary,/45.00 USD/);
  assert.equal(result.diagnostics[0].http_status,200);
  assert.equal(result.diagnostics[0].fallback_used,true);
  assert.equal(result.diagnostics[0].fallback_stage,'discover');
  assert.equal(result.diagnostics[0].primary_http_status,500);
  assert.equal(result.diagnostics[0].accepted,1);
});

test('PayanAgent accepts filtered open requests before hitting unified discovery',async()=>{
  const db=new DemandDb();
  const calls=[];
  const primaryUrl='https://payanagent.com/api/v1/requests?status=open&limit=50';
  const filteredUrl='https://payanagent.com/api/v1/requests?status=open&q=csv&limit=50';
  const fetcher=async(url,init={})=>{
    calls.push({url,method:init.method||'GET'});
    if(url===primaryUrl) return {ok:false,status:500,contentType:'application/json',text:'{"error":"listOpen unavailable"}'};
    if(url===filteredUrl) return {ok:true,status:200,contentType:'application/json',text:JSON.stringify({
      requests:[{
        _id:'payan-filtered-94',
        _creationTime:Date.parse('2026-10-28T12:00:00Z'),
        status:'open',
        title:'Clean and validate a CSV dataset',
        description:'Need duplicate-row removal, schema validation, and normalized CSV output.',
        budgetMaxCents:5000,
        currency:'USD',
        escrow:false
      }]
    })};
    throw new Error('Unexpected URL: '+url);
  };
  const result=await scanAgentDemand(db,{
    fetcher,
    sources:[{source:'payanagent_open_requests',provider:'PayanAgent Open Requests',url:primaryUrl}],
    now:Date.parse('2026-10-29T00:00:00Z')
  });
  assert.equal(result.signals.length,1);
  assert.equal(result.signals[0].id,'payan-filtered-94');
  assert.deepEqual(calls,[
    {url:primaryUrl,method:'GET'},
    {url:filteredUrl,method:'GET'}
  ]);
  assert.equal(result.diagnostics[0].fallback_stage,'filtered_requests');
  assert.equal(result.diagnostics[0].primary_http_status,500);
  assert.equal(result.diagnostics[0].accepted,1);
});

test('PayanAgent records final endpoint diagnostics and creates no signal when all three reads fail',async()=>{
  const db=new DemandDb();
  const calls=[];
  const result=await scanAgentDemand(db,{
    fetcher:async(url,init={})=>{
      calls.push({url,method:init.method||'GET'});
      return {ok:false,status:500,contentType:'application/json',text:'{"error":"unavailable"}'};
    },
    sources:[{source:'payanagent_open_requests',provider:'PayanAgent Open Requests',url:'https://payanagent.com/api/v1/requests?status=open&limit=50'}]
  });
  assert.equal(result.ok,true);
  assert.equal(result.signals.length,0);
  assert.equal(db.signals.length,0);
  assert.equal(calls.length,3);
  assert.ok(calls.every(call=>call.method==='GET'));
  assert.equal(result.diagnostics[0].status,'HTTP_ERROR');
  assert.equal(result.diagnostics[0].http_status,500);
  assert.equal(result.diagnostics[0].fallback_used,true);
  assert.equal(result.diagnostics[0].fallback_stage,'discover');
  assert.equal(result.diagnostics[0].primary_http_status,500);
  assert.equal(result.diagnostics[0].intermediate_http_status,500);
  assert.equal(result.diagnostics[0].endpoint,'https://payanagent.com/api/v1/discover?q=csv&limit=50');
});


test('scan persists per-source raw, recent, accepted, rejected and rejection metrics',async()=>{
  const db=new DemandDb();
  const now=Date.parse('2026-10-29T00:00:00Z');
  const result=await scanAgentDemand(db,{
    now,
    sources:[{source:'opentask_public_tasks',provider:'Fixture Metrics',url:'https://market.example/api/listings'}],
    fetcher:async()=>({ok:true,status:200,contentType:'application/json',text:JSON.stringify({listings:[
      {id:'fresh-1',createdAt:'2026-10-28T00:00:00Z',title:'CSV data quality review',description:'Need a CSV dataset validated, normalized, and returned as a clean spreadsheet.',url:'https://market.example/jobs/fresh-1'},
      {id:'mismatch-1',createdAt:'2026-10-27T00:00:00Z',title:'Plumbing repair request',description:'Need a local plumber to fix a leaking kitchen sink.',url:'https://market.example/jobs/mismatch-1'},
      {id:'stale-1',createdAt:'2026-09-01T00:00:00Z',title:'Old CSV data quality review',description:'Need a CSV dataset validated and normalized.',url:'https://market.example/jobs/stale-1'}
    ]})})
  });
  assert.equal(result.ok,true);
  assert.equal(db.runs.length,1);
  const run=db.runs[0];
  assert.equal(run.raw_count,3);
  assert.equal(run.raw_recent_count,2);
  assert.equal(run.accepted_count,1);
  assert.equal(run.rejected_count,2);
  assert.equal(run.duplicate_count,0);
  assert.equal(run.http_status,200);
  assert.equal(run.source_status,'OK');
  assert.deepEqual(JSON.parse(run.rejection_counts_json),{service_mismatch:1,stale:1});
  assert.ok(run.response_ms>=0);
  assert.ok(run.scan_id);
});

test('scan records HTTP failures and timeout outcomes without row content',async()=>{
  const httpDb=new DemandDb();
  await scanAgentDemand(httpDb,{
    sources:[{source:'fixture_http_error',provider:'Fixture',url:'https://market.example/api'}],
    fetcher:async()=>({ok:false,status:503,text:'upstream unavailable'})
  });
  assert.equal(httpDb.runs[0].raw_count,0);
  assert.equal(httpDb.runs[0].http_status,503);
  assert.equal(httpDb.runs[0].source_status,'HTTP_ERROR');
  assert.equal(httpDb.runs[0].error_code,'HTTP_503');

  const timeoutDb=new DemandDb();
  await scanAgentDemand(timeoutDb,{
    sources:[{source:'fixture_timeout',provider:'Fixture',url:'https://market.example/api'}],
    fetcher:async()=>{const error=new Error('request aborted');error.name='AbortError';throw error;}
  });
  assert.equal(timeoutDb.runs[0].source_status,'TIMEOUT');
  assert.equal(timeoutDb.runs[0].error_code,'TIMEOUT');
  assert.equal(timeoutDb.runs[0].raw_count,0);
});

test('scan records zero-result and duplicate-only runs',async()=>{
  const zeroDb=new DemandDb();
  await scanAgentDemand(zeroDb,{
    sources:[{source:'fixture_zero',provider:'Fixture',url:'https://market.example/api'}],
    fetcher:async()=>({ok:true,status:200,text:'{"listings":[]}'})
  });
  assert.equal(zeroDb.runs[0].raw_count,0);
  assert.equal(zeroDb.runs[0].accepted_count,0);
  assert.equal(zeroDb.runs[0].source_status,'OK');

  const duplicateDb=new DemandDb();
  const source={source:'fixture_duplicate',provider:'Fixture',url:'https://market.example/api'};
  const fetcher=async()=>({ok:true,status:200,text:JSON.stringify({listings:[
    {id:'duplicate-1',createdAt:'2026-10-28T00:00:00Z',title:'CSV data quality review',description:'Need a CSV dataset validated, normalized, and returned as a clean spreadsheet.',url:'https://market.example/jobs/duplicate-1'}
  ]})});
  await scanAgentDemand(duplicateDb,{sources:[source],fetcher});
  await scanAgentDemand(duplicateDb,{sources:[source],fetcher});
  assert.equal(duplicateDb.runs.length,2);
  assert.equal(duplicateDb.runs[1].raw_count,1);
  assert.equal(duplicateDb.runs[1].accepted_count,0);
  assert.equal(duplicateDb.runs[1].duplicate_count,1);
});

test('failure to persist observability metrics never stops a demand scan',async()=>{
  const db=new DemandDb();
  db.failMetrics=true;
  const result=await scanAgentDemand(db,{
    sources:[{source:'fixture_metrics_failure',provider:'Fixture',url:'https://market.example/api'}],
    fetcher:async()=>({ok:true,status:200,text:JSON.stringify({listings:[
      {id:'metric-fail-1',title:'CSV data quality review',description:'Need a CSV dataset validated and normalized.',url:'https://market.example/jobs/metric-fail-1'}
    ]})})
  });
  assert.equal(result.ok,true);
  assert.equal(result.signals.length,1);
  assert.equal(db.signals.length,1);
  assert.equal(db.runs.length,0);
});


test('AgentJob persistent 60-second gate blocks repeated manual scans before MCP initialization',async()=>{
  const db=new DemandDb();
  const now=Date.parse('2026-10-29T10:00:00.000Z');
  const calls=[];
  const fetcher=async(url,init)=>{
    const payload=JSON.parse(init.body);
    calls.push(payload.method);
    if(payload.method==='initialize') return {ok:true,status:200,contentType:'application/json',headers:{'mcp-session-id':'test-session'},text:JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'fixture',version:'1'}}})};
    if(payload.method==='notifications/initialized') return {ok:true,status:202,contentType:'application/json',headers:{'mcp-session-id':'test-session'},text:'{}'};
    return {ok:true,status:200,contentType:'application/json',headers:{'mcp-session-id':'test-session'},text:JSON.stringify({jsonrpc:'2.0',id:2,result:{content:[{type:'text',text:'{"posts":[]}'}]}})};
  };
  const sources=[{source:'agent_job_public_mcp',provider:'AgentJob',protocol:'MCP'}];
  const first=await scanAgentDemand(db,{sources,fetcher,now});
  assert.equal(first.ok,true);
  assert.deepEqual(calls,['initialize','notifications/initialized','tools/call']);
  const second=await scanAgentDemand(db,{sources,fetcher,now:now+59000});
  assert.equal(second.diagnostics[0].status,'POLL_GATE');
  assert.equal(calls.length,3);
  const third=await scanAgentDemand(db,{sources,fetcher,now:now+61000});
  assert.equal(third.ok,true);
  assert.equal(calls.length,6);
  assert.deepEqual(calls.slice(3),['initialize','notifications/initialized','tools/call']);
});
