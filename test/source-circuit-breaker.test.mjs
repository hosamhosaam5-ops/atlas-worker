import test from 'node:test';
import assert from 'node:assert/strict';
import { recordPayanAgentOutcome, recordSourceOutcome, sourceCircuitState } from '../src/autonomy/engine.js';

function mockDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() {
          if (sql.includes('FROM source_health WHERE source_id=?')) return rows.get(values[0]) || null;
          if (sql.includes('FROM autonomy_policies')) return {max_tool_calls:20,max_retries:3,max_execution_seconds:120,max_external_requests:30,max_build_iterations:5,outbound_spend_allowed:0};
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO source_health')) {
            rows.set(values[0], {
              source_id:values[0], consecutive_failures:values[1], state:values[2],
              last_status:values[3], last_error:values[4], last_tested_at:values[5],
              cooldown_until:values[6]
            });
          }
          return {success:true};
        },
        async all() { return {results:[]}; }
      };
    }
  };
}

test('failed source enters persistent cooldown and is skipped until expiry', async () => {
  const db = mockDb();
  const now = Date.parse('2026-10-29T10:00:00.000Z');
  const failed = await recordSourceOutcome(db,'payanagent_open_requests',{ok:false,status:500,error:'HTTP_ERROR',now});
  assert.equal(failed.state,'COOLDOWN');
  assert.equal(failed.consecutive_failures,1);
  assert.equal((await sourceCircuitState(db,'payanagent_open_requests',now+60_000)).blocked,true);
  const expired = await sourceCircuitState(db,'payanagent_open_requests',now+16*60_000);
  assert.equal(expired.blocked,false);
  assert.equal(expired.probe_due,true);
});

test('successful read-only probe clears cooldown; failures do not affect another source', async () => {
  const db = mockDb();
  const now = Date.parse('2026-10-29T10:00:00.000Z');
  await recordSourceOutcome(db,'payanagent_open_requests',{ok:false,status:500,now});
  await recordSourceOutcome(db,'opentask_public_tasks',{ok:true,status:200,now});
  assert.equal((await sourceCircuitState(db,'opentask_public_tasks',now)).blocked,false);
  await recordSourceOutcome(db,'payanagent_open_requests',{ok:true,status:200,now:now+16*60_000});
  const recovered = await sourceCircuitState(db,'payanagent_open_requests',now+16*60_000);
  assert.equal(recovered.blocked,false);
  assert.equal(recovered.probe_due,false);
  assert.equal(db.rows.get('payanagent_open_requests').consecutive_failures,0);
});


test('PayanAgent primary HTTP 500 remains in cooldown when fallback succeeds', async () => {
  const db = mockDb();
  const now = Date.parse('2026-10-29T10:00:00.000Z');
  const outcome = await recordPayanAgentOutcome(db, 'payanagent_open_requests', {
    ok: true,
    status: 200,
    primaryHttpStatus: 500,
    fallbackUsed: true,
    fallbackStage: 'filtered_requests'
  }, now);

  assert.equal(outcome.state, 'COOLDOWN');
  assert.equal(outcome.consecutive_failures, 1);
  assert.equal(outcome.primary_degraded, true);
  assert.equal(db.rows.get('payanagent_open_requests').last_status, '500');
  assert.equal(db.rows.get('payanagent_open_requests').last_error, 'PRIMARY_HTTP_ERROR');

  const circuit = await sourceCircuitState(db, 'payanagent_open_requests', now + 60_000);
  assert.equal(circuit.blocked, true);
  assert.equal(circuit.state, 'COOLDOWN');
});
