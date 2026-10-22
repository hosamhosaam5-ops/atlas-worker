import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGrowthActions } from '../src/autonomy/engine.js';

class GrowthActionsDb {
  constructor() {
    this.actions = [];
    this.updatedSignals = [];
    this.signal = {
      id: 101,
      source: 'fixture_marketplace',
      signal_key: 'fixture_marketplace|job-101',
      request_summary: 'Need a specialist to validate columns, normalize values, and return a cleaned CSV.',
      score: 0.8
    };
  }

  prepare(sql) {
    const db = this;
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async all() {
        if (sql.includes('FROM demand_signals WHERE status=\'NEW\'')) {
          return { results: [db.signal] };
        }
        return { results: [] };
      },
      async first() {
        if (sql.includes('FROM growth_actions WHERE action_key=?')) {
          // Simulate Cloudflare D1: SQL placeholders must be bound before first().
          if (values.length !== 1 || values[0] !== 'qualify|' + db.signal.signal_key) {
            throw new Error('D1_ERROR: Wrong number of parameter bindings for SQL query.');
          }
          return db.actions.find(action => action.action_key === values[0]) || null;
        }
        return null;
      },
      async run() {
        if (sql.includes('INSERT INTO growth_actions')) {
          const [action_key, action_type, target_id, payload_json, status, risk] = values;
          db.actions.push({ action_key, action_type, target_id, payload_json, status, risk });
          return { meta: { changes: 1 } };
        }
        if (sql.includes('UPDATE demand_signals SET status=')) {
          db.updatedSignals.push({ id: values[1], status: values[0] });
        }
        return { meta: { changes: 1 } };
      }
    };
  }
}

test('prepareGrowthActions binds the action key and qualifies a valid lead once', async () => {
  const db = new GrowthActionsDb();

  const first = await prepareGrowthActions(db);
  assert.equal(first.ok, true);
  assert.equal(first.actions.length, 1);
  assert.equal(first.actions[0].id, 101);
  assert.equal(first.actions[0].status, 'READY');
  assert.equal(db.actions.length, 1);
  assert.equal(db.actions[0].action_key, 'qualify|' + db.signal.signal_key);
  assert.equal(db.updatedSignals[0].status, 'QUALIFIED');

  const second = await prepareGrowthActions(db);
  assert.equal(second.ok, true);
  assert.equal(second.actions.length, 0);
  assert.equal(db.actions.length, 1);
});
