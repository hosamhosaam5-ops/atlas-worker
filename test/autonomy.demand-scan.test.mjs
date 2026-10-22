import test from 'node:test';
import assert from 'node:assert/strict';
import { extractListings, scanAgentDemand } from '../src/autonomy/engine.js';

class DemandDb {
  constructor(){ this.signals=[]; this.nextId=1; }
  prepare(sql){
    const db=this;
    let values=[];
    return {
      bind(...args){ values=args; return this; },
      async first(...args){
        const key=args[0] ?? values[0];
        if(sql.includes('autonomy_policies')) return {policy_id:'default',max_external_requests:30,max_tool_calls:20,max_retries:3,max_execution_seconds:120,max_build_iterations:5,outbound_spend_allowed:0};
        if(sql.includes('SELECT id FROM demand_signals')) return db.signals.find(s=>s.signal_key===key)||null;
        return null;
      },
      async run(){
        if(sql.includes('INSERT INTO demand_signals')){
          const [source,signal_key,request_summary,score,status]=values;
          if(db.signals.some(s=>s.signal_key===signal_key)) throw new Error('UNIQUE constraint failed: demand_signals.signal_key');
          db.signals.push({id:db.nextId++,source,signal_key,request_summary,score,status});
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
    {id:'job-42',title:'CSV data quality review',description:'Need a specialist to validate columns, normalize values, and return a cleaned CSV.',url:'https://market.example/jobs/42'}
  ]})};};
  const options={fetcher,sources:[{source:'fixture_marketplace',provider:'Fixture Marketplace',url:'https://market.example/api/listings'}]};
  const first=await scanAgentDemand(db,options);
  assert.equal(first.ok,true);
  assert.equal(first.signals.length,1);
  assert.equal(db.signals.length,1);
  assert.equal(db.signals[0].status,'NEW');
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
    listings_seen:0,offers_excluded:0,accepted:0,duplicates:0,rejected:0
  });
});

test('OpenTask public agent tasks become signals while upfront-funding tasks are rejected and duplicates deduplicated',async()=>{
  const db=new DemandDb();
  const fetcher=async()=>({ok:true,status:200,contentType:'application/json',text:JSON.stringify({
    tasks:[
      {
        id:'opentask-csv-77',
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
  })});
  const options={fetcher,sources:[{
    source:'opentask_public_tasks',
    provider:'OpenTask Public Tasks',
    url:'https://opentask.ai/api/tasks?limit=50'
  }]};
  const first=await scanAgentDemand(db,options);
  assert.equal(first.ok,true);
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