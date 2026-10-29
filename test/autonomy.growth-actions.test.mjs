import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGrowthActions, verifyOriginalSourceLink } from '../src/autonomy/engine.js';

const NOW=Date.parse('2026-10-29T10:00:00.000Z');
const VALID_SUMMARY='Need a specialist to validate columns, normalize values, and return a cleaned CSV.';
const VALID_URL='https://market.example/jobs/101';

function signal(overrides={}) {
  return {
    id:101,
    source:'opentask_public_tasks',
    signal_key:'opentask_public_tasks|job-101',
    request_summary:VALID_SUMMARY,
    score:0.8,
    source_url:VALID_URL,
    created_at:'2026-10-28T10:00:00.000Z',
    status:'NEW',
    ...overrides
  };
}

class GrowthActionsDb {
  constructor(signals=[signal()]) {
    this.signals=signals;
    this.actions=[];
    this.updatedSignals=[];
  }

  prepare(sql) {
    const db=this;
    let values=[];
    return {
      bind(...args){values=args;return this;},
      async all(){
        if(sql.includes("FROM demand_signals WHERE status='NEW'")) {
          return {results:db.signals.filter(row=>row.status==='NEW')};
        }
        return {results:[]};
      },
      async first(){
        if(sql.includes('FROM growth_actions WHERE action_key=?')) {
          return db.actions.find(action=>action.action_key===values[0])||null;
        }
        if(sql.includes('MIN(id) AS canonical_id')) {
          const matches=db.signals.filter(row=>row.signal_key===values[0]);
          return {canonical_id:matches.length?Math.min(...matches.map(row=>row.id)):null,duplicate_count:matches.length};
        }
        return null;
      },
      async run(){
        if(sql.includes('INSERT INTO growth_actions')) {
          const [action_key,action_type,target_id,payload_json,status,risk]=values;
          db.actions.push({action_key,action_type,target_id,payload_json,status,risk});
          return {meta:{changes:1}};
        }
        if(sql.includes("UPDATE demand_signals SET status='QUALIFIED'")) {
          const [last_verified_at,id,source_url]=values;
          const row=db.signals.find(item=>item.id===id);
          if(row&&row.status==='NEW'&&row.source_url===source_url) {
            row.status='QUALIFIED';
            row.last_verified_at=last_verified_at;
            db.updatedSignals.push({id,status:'QUALIFIED',last_verified_at});
            return {meta:{changes:1}};
          }
        }
        return {meta:{changes:0}};
      }
    };
  }
}

function openLinkFetcher(calls=[]) {
  return async(url,init)=>{
    calls.push({url,method:init.method});
    return {ok:true,status:200};
  };
}

test('prepareGrowthActions verifies the original link, age, capability and uniqueness before qualification',async()=>{
  const db=new GrowthActionsDb();
  const calls=[];
  const first=await prepareGrowthActions(db,{now:NOW,linkFetcher:openLinkFetcher(calls)});
  assert.equal(first.ok,true);
  assert.equal(first.actions.length,1);
  assert.equal(first.actions[0].id,101);
  assert.equal(first.actions[0].status,'READY');
  assert.equal(first.actions[0].last_verified_at,new Date(NOW).toISOString());
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,VALID_URL);
  assert.equal(calls[0].method,'HEAD');
  assert.equal(db.actions.length,1);
  assert.equal(db.actions[0].action_key,'qualify|'+db.signals[0].signal_key);
  assert.equal(db.signals[0].status,'QUALIFIED');
  assert.equal(db.signals[0].last_verified_at,new Date(NOW).toISOString());
  const payload=JSON.parse(db.actions[0].payload_json);
  assert.equal(payload.source_url,VALID_URL);
  assert.equal(payload.last_verified_at,new Date(NOW).toISOString());

  const second=await prepareGrowthActions(db,{now:NOW+1000,linkFetcher:openLinkFetcher(calls)});
  assert.equal(second.actions.length,0);
  assert.equal(db.actions.length,1);
  assert.equal(calls.length,1);
});

test('closed original links do not qualify and do not set last_verified_at',async()=>{
  const db=new GrowthActionsDb();
  const result=await prepareGrowthActions(db,{now:NOW,linkFetcher:async()=>({ok:false,status:404})});
  assert.equal(result.actions.length,0);
  assert.equal(result.skipped.SOURCE_LINK_NOT_OPEN,1);
  assert.equal(db.actions.length,0);
  assert.equal(db.signals[0].status,'NEW');
  assert.equal(db.signals[0].last_verified_at,undefined);
});

test('HEAD 405 falls back to a bounded GET without a session delay',async()=>{
  const calls=[];
  const result=await verifyOriginalSourceLink(VALID_URL,async(url,init)=>{
    calls.push(init.method);
    if(init.method==='HEAD') return {ok:false,status:405};
    assert.equal(init.headers.Range,'bytes=0-0');
    return {ok:true,status:206};
  });
  assert.equal(result.ok,true);
  assert.deepEqual(calls,['HEAD','GET']);
});

test('stale, unknown-age, missing-link, paid-registration and out-of-capability rows are not counted',async()=>{
  const cases=[
    {row:signal({created_at:'2026-09-01T10:00:00.000Z'}),reason:'stale'},
    {row:signal({created_at:'2026-10-29T10:00:00.000Z',source_url:null}),reason:'missing_source_url'},
    {row:signal({created_at:null,source_url:null}),reason:'unverified_age'},
    {row:signal({request_summary:'Paid registration fee required before the task can begin.'}),reason:'financial_prerequisite'},
    {row:signal({request_summary:'Need a plumber to repair a leaking kitchen sink.'}),reason:'service_mismatch'}
  ];
  for(const item of cases){
    const db=new GrowthActionsDb([item.row]);
    let fetchCount=0;
    const result=await prepareGrowthActions(db,{now:NOW,linkFetcher:async()=>{fetchCount++;return {ok:true,status:200};}});
    assert.equal(result.actions.length,0,item.reason);
    assert.equal(result.skipped[item.reason],1,item.reason);
    assert.equal(db.actions.length,0,item.reason);
    assert.equal(fetchCount,0,item.reason);
    assert.equal(item.row.status,'NEW',item.reason);
  }
});

test('duplicate signal keys produce at most one qualified action',async()=>{
  const first=signal();
  const duplicate=signal({id:102});
  const db=new GrowthActionsDb([first,duplicate]);
  const result=await prepareGrowthActions(db,{now:NOW,linkFetcher:openLinkFetcher()});
  assert.equal(result.actions.length,1);
  assert.equal(db.actions.length,1);
  assert.equal(first.status,'QUALIFIED');
  assert.equal(duplicate.status,'NEW');
  assert.equal(result.skipped.duplicate_signal,1);
});


test('public source link redirects cannot target private addresses',async()=>{
  let calls=0;
  const result=await verifyOriginalSourceLink(VALID_URL,async()=>{
    calls++;
    return {ok:false,status:302,headers:{get(name){return name==='location'?'http://127.0.0.1/admin':null;}}};
  });
  assert.equal(result.ok,false);
  assert.equal(result.reason,'UNSAFE_REDIRECT_TARGET');
  assert.equal(calls,1);
});

test('private and non-HTTP source URLs are rejected without fetching',async()=>{
  for(const url of ['http://127.0.0.1/admin','http://169.254.169.254/latest/meta-data','file:///etc/passwd','javascript:alert(1)']){
    let calls=0;
    const result=await verifyOriginalSourceLink(url,async()=>{calls++;return {ok:true,status:200};});
    assert.equal(result.ok,false,url);
    assert.equal(calls,0,url);
  }
});
