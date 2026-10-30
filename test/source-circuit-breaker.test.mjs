import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimAgentJobListPostsGate,
  claimHalfOpenProbe,
  recordPayanAgentOutcome,
  recordSourceOutcome,
  sourceCircuitState
} from '../src/autonomy/engine.js';

function sqliteDb(filename=':memory:') {
  const sqlite=new DatabaseSync(filename);
  sqlite.exec(`
    CREATE TABLE demand_source_health (
      source TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'CLOSED',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      opened_at TEXT,
      next_probe_at TEXT,
      cooldown_ms INTEGER NOT NULL DEFAULT 900000,
      last_status INTEGER,
      last_error_code TEXT,
      last_success_at TEXT,
      last_attempt_at TEXT,
      last_http_status INTEGER,
      last_response_ms INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return {
    sqlite,
    prepare(sql) {
      let values=[];
      return {
        bind(...args){values=args;return this;},
        async first(){return sqlite.prepare(sql).get(...values)||null;},
        async run(){const result=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(result.changes||0)}};},
        async all(){return {results:sqlite.prepare(sql).all(...values)};}
      };
    },
    close(){sqlite.close();}
  };
}

test('three consecutive 5xx/timeout failures open the circuit; half-open allows one probe',async()=>{
  const db=sqliteDb();
  const now=Date.parse('2026-10-29T10:00:00.000Z');
  const first=await recordSourceOutcome(db,'source_a',{ok:false,status:500,error:'HTTP_ERROR',responseMs:10,now});
  const second=await recordSourceOutcome(db,'source_a',{ok:false,status:502,error:'HTTP_ERROR',responseMs:11,now:now+1000});
  assert.equal(first.state,'CLOSED');
  assert.equal(first.consecutive_failures,1);
  assert.equal(second.state,'CLOSED');
  assert.equal(second.consecutive_failures,2);

  const third=await recordSourceOutcome(db,'source_a',{ok:false,status:503,error:'HTTP_ERROR',responseMs:12,now:now+2000});
  assert.equal(third.state,'OPEN');
  assert.equal(third.consecutive_failures,3);
  assert.equal(third.cooldown_ms,15*60*1000);
  assert.equal(third.next_probe_at,new Date(now+2000+15*60*1000).toISOString());
  assert.equal((await sourceCircuitState(db,'source_a',now+14*60*1000)).blocked,true);

  const due=await sourceCircuitState(db,'source_a',now+15*60*1000+2000);
  assert.equal(due.blocked,false);
  assert.equal(due.probe_due,true);
  assert.equal(await claimHalfOpenProbe(db,'source_a',now+15*60*1000+2000),true);
  assert.equal(await claimHalfOpenProbe(db,'source_a',now+15*60*1000+2001),false);
  assert.equal((await sourceCircuitState(db,'source_a',now+15*60*1000+2002)).state,'HALF_OPEN');

  const failedProbe=await recordSourceOutcome(db,'source_a',{ok:false,status:'TIMEOUT',error:'TIMEOUT',now:now+15*60*1000+3000});
  assert.equal(failedProbe.state,'OPEN');
  assert.equal(failedProbe.consecutive_failures,4);
  assert.equal(failedProbe.cooldown_ms,30*60*1000);

  const nextDue=Date.parse(failedProbe.next_probe_at);
  assert.equal((await sourceCircuitState(db,'source_a',nextDue)).probe_due,true);
  assert.equal(await claimHalfOpenProbe(db,'source_a',nextDue),true);
  const recovered=await recordSourceOutcome(db,'source_a',{ok:true,status:200,responseMs:5,now:nextDue+1});
  assert.equal(recovered.state,'CLOSED');
  assert.equal(recovered.consecutive_failures,0);
  assert.equal(recovered.cooldown_ms,15*60*1000);
  assert.equal(recovered.next_probe_at,null);
  db.close();
});

test('exponential circuit cooldown increases after failed half-open probes and caps at six hours',async()=>{
  const db=sqliteDb();
  const now=Date.parse('2026-10-29T10:00:00.000Z');
  let t=now;
  let outcome;
  for(let i=0;i<3;i++) outcome=await recordSourceOutcome(db,'source_backoff',{ok:false,status:500,error:'HTTP_ERROR',now:t+i});
  assert.equal(outcome.cooldown_ms,15*60*1000);
  let expected=15*60*1000;
  for(let i=0;i<6;i++){
    const due=Date.parse(outcome.next_probe_at);
    assert.equal(await claimHalfOpenProbe(db,'source_backoff',due),true);
    outcome=await recordSourceOutcome(db,'source_backoff',{ok:false,status:504,error:'HTTP_ERROR',now:due+1});
    expected=Math.min(expected*2,6*60*60*1000);
    assert.equal(outcome.cooldown_ms,expected);
  }
  assert.equal(outcome.cooldown_ms,6*60*60*1000);
  db.close();
});

test('429 opens until Retry-After while 401/403 remain actionable non-transient errors',async()=>{
  const db=sqliteDb();
  const now=Date.parse('2026-10-29T10:00:00.000Z');
  const limited=await recordSourceOutcome(db,'rate_limited',{ok:false,status:429,error:'HTTP_ERROR',retryAfter:'120',now});
  assert.equal(limited.state,'OPEN');
  assert.equal(limited.consecutive_failures,0);
  assert.equal(limited.next_probe_at,new Date(now+120000).toISOString());
  assert.equal((await sourceCircuitState(db,'rate_limited',now+119999)).blocked,true);
  assert.equal((await sourceCircuitState(db,'rate_limited',now+120000)).probe_due,true);

  for(const status of [401,403]){
    const auth=await recordSourceOutcome(db,'auth_'+status,{ok:false,status,error:'HTTP_ERROR',now});
    assert.equal(auth.state,'CLOSED');
    assert.equal(auth.consecutive_failures,0);
    assert.equal(auth.last_error_code,'AUTH_REQUIRED');
    assert.equal(auth.next_probe_at,null);
    assert.equal((await sourceCircuitState(db,'auth_'+status,now)).blocked,false);
  }
  db.close();
});

test('source failures are isolated and a successful probe resets only its own source',async()=>{
  const db=sqliteDb();
  const now=Date.parse('2026-10-29T10:00:00.000Z');
  await recordSourceOutcome(db,'source_a',{ok:false,status:500,now});
  const healthy=await recordSourceOutcome(db,'source_b',{ok:true,status:200,now});
  assert.equal(healthy.state,'CLOSED');
  assert.equal((await sourceCircuitState(db,'source_b',now)).blocked,false);
  await recordSourceOutcome(db,'source_a',{ok:true,status:200,now:now+1000});
  const recovered=await sourceCircuitState(db,'source_a',now+1000);
  assert.equal(recovered.blocked,false);
  assert.equal(recovered.state,'CLOSED');
  db.close();
});

test('PayanAgent primary HTTP 500 respects the three-failure threshold when fallback succeeds',async()=>{
  const db=sqliteDb();
  const now=Date.parse('2026-10-29T10:00:00.000Z');
  const response={
    ok:true,status:200,primaryHttpStatus:500,fallbackUsed:true,fallbackStage:'filtered_requests',responseMs:23
  };
  const first=await recordPayanAgentOutcome(db,'payanagent_open_requests',response,now);
  const second=await recordPayanAgentOutcome(db,'payanagent_open_requests',response,now+1000);
  const third=await recordPayanAgentOutcome(db,'payanagent_open_requests',response,now+2000);

  assert.equal(first.state,'CLOSED');
  assert.equal(first.consecutive_failures,1);
  assert.equal(first.next_probe_at,null);
  assert.equal(second.state,'CLOSED');
  assert.equal(second.consecutive_failures,2);
  assert.equal(second.next_probe_at,null);
  assert.equal(third.state,'OPEN');
  assert.equal(third.consecutive_failures,3);
  assert.equal(third.next_probe_at,new Date(now+2000+15*60*1000).toISOString());
  assert.equal(third.primary_degraded,true);

  const row=await db.prepare('SELECT * FROM demand_source_health WHERE source=?').bind('payanagent_open_requests').first();
  assert.equal(row.state,'OPEN');
  assert.equal(row.last_status,500);
  assert.equal(row.last_http_status,500);
  assert.equal(row.last_error_code,'PRIMARY_HTTP_ERROR');
  assert.equal(row.last_response_ms,23);
  assert.equal(row.next_probe_at,new Date(now+2000+15*60*1000).toISOString());
  db.close();
});

test('a final PayanAgent HTTP 500 opens only after three consecutive failures',async()=>{
  const db=sqliteDb();
  const now=Date.parse('2026-10-29T10:00:00.000Z');
  const first=await recordSourceOutcome(db,'payanagent_open_requests',{ok:false,status:500,error:'HTTP_ERROR',responseMs:42,now});
  const second=await recordSourceOutcome(db,'payanagent_open_requests',{ok:false,status:500,error:'HTTP_ERROR',responseMs:42,now:now+1000});
  const third=await recordSourceOutcome(db,'payanagent_open_requests',{ok:false,status:500,error:'HTTP_ERROR',responseMs:42,now:now+2000});

  assert.equal(first.state,'CLOSED');
  assert.equal(first.consecutive_failures,1);
  assert.equal(first.next_probe_at,null);
  assert.equal(second.state,'CLOSED');
  assert.equal(second.consecutive_failures,2);
  assert.equal(second.next_probe_at,null);
  assert.equal(third.state,'OPEN');
  assert.equal(third.consecutive_failures,3);
  assert.equal(third.last_error_code,'HTTP_500');
  assert.equal(third.next_probe_at,new Date(now+2000+15*60*1000).toISOString());

  const row=await db.prepare('SELECT * FROM demand_source_health WHERE source=?').bind('payanagent_open_requests').first();
  assert.equal(row.state,'OPEN');
  assert.equal(row.last_http_status,500);
  assert.equal(row.last_response_ms,42);
  assert.equal(row.next_probe_at,new Date(now+2000+15*60*1000).toISOString());
  db.close();
});

test('AgentJob list_posts gate enforces 0/59999/60000/60001ms exactly in real SQLite',async()=>{
  const db=sqliteDb();
  const now=Date.parse('2026-10-29T10:00:00.000Z');
  for(const [offset,expectedAllowed] of [[0,false],[59999,false],[60000,true],[60001,true]]){
    const source='boundary_'+offset;
    assert.equal((await claimAgentJobListPostsGate(db,source,now)).allowed,true);
    const result=await claimAgentJobListPostsGate(db,source,now+offset);
    assert.equal(result.allowed,expectedAllowed,'offset '+offset+'ms');
    if(expectedAllowed)assert.equal(result.last_attempt_at,new Date(now+offset).toISOString());
  }
  db.close();
});

test('AgentJob list_posts gate persists across SQLite reopen and is atomic across real concurrent SQLite connections',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'atlas-agentjob-gate-'));
  const filename=join(dir,'demand-source-health.sqlite');
  const source='agent_job_public_mcp';
  const now=Date.parse('2026-10-29T10:00:00.000Z');
  let db=sqliteDb(filename);
  const workers=[];
  try{
    const first=await claimAgentJobListPostsGate(db,source,now);
    assert.equal(first.allowed,true);
    assert.equal(first.last_attempt_at,new Date(now).toISOString());
    db.close();
    db=sqliteDb(filename);
    const persisted=await db.prepare('SELECT last_attempt_at FROM demand_source_health WHERE source=?').bind(source).first();
    assert.equal(persisted.last_attempt_at,new Date(now).toISOString());
    assert.equal((await claimAgentJobListPostsGate(db,source,now+59999)).allowed,false);
    db.close();
    db=null;

    const workerCode = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      (async () => {
        const { claimAgentJobListPostsGate } = await import(workerData.engineUrl);
        const sqlite = new DatabaseSync(workerData.filename);
        sqlite.exec('PRAGMA busy_timeout=5000');
        const adapter = {
          prepare(sql) {
            let values = [];
            return {
              bind(...args) { values = args; return this; },
              async first() { return sqlite.prepare(sql).get(...values) || null; }
            };
          }
        };
        parentPort.postMessage({ ready: true });
        await new Promise(resolve => parentPort.once('message', resolve));
        const result = await claimAgentJobListPostsGate(adapter, workerData.source, workerData.now);
        parentPort.postMessage({ result });
        sqlite.close();
      })().catch(error => {
        parentPort.postMessage({ worker_error: String(error?.message || error) });
      });
    `;
    const workerNow=now+60000;
    const engineUrl=new URL('../src/autonomy/engine.js',import.meta.url).href;
    const tracked=[0,1].map(()=> {
      const worker=new Worker(workerCode,{eval:true,workerData:{filename,source,now:workerNow,engineUrl}});
      workers.push(worker);
      let readyResolve,resultResolve,readyReject,resultReject;
      const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
      const result=new Promise((resolve,reject)=>{resultResolve=resolve;resultReject=reject;});
      worker.on('message',message=>{
        if(message.ready)readyResolve();
        else if(message.result)resultResolve(message.result);
        else if(message.worker_error){
          const error=new Error(message.worker_error);
          readyReject(error);
          resultReject(error);
        }
      });
      worker.on('error',error=>{readyReject(error);resultReject(error);});
      worker.on('exit',code=>{
        if(code!==0){
          const error=new Error('gate worker exit '+code);
          readyReject(error);
          resultReject(error);
        }
      });
      return {worker,ready,result};
    });
    await Promise.all(tracked.map(item=>item.ready));
    tracked.forEach(item=>item.worker.postMessage('go'));
    const outcomes=await Promise.all(tracked.map(item=>item.result));
    assert.deepEqual(outcomes.map(item=>item.allowed).sort(),[false,true]);
    db=sqliteDb(filename);
    const finalRow=await db.prepare('SELECT last_attempt_at FROM demand_source_health WHERE source=?').bind(source).first();
    assert.equal(finalRow.last_attempt_at,new Date(workerNow).toISOString());
  }finally{
    for(const worker of workers)await worker.terminate();
    if(db)db.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('AgentJob gate fails closed when D1 cannot persist the 60-second claim',async()=>{
  const db={prepare(){throw new Error('D1 unavailable');}};
  const gate=await claimAgentJobListPostsGate(db,'agent_job_public_mcp',Date.now());
  assert.equal(gate.allowed,false);
  assert.equal(gate.reason,'D1_POLL_GATE_UNAVAILABLE');
});
