import test from 'node:test';
import assert from 'node:assert/strict';
import { runTelegraphMonitor } from '../src/crons/telegraphMonitor.js';
import { runRevenueWatch } from '../src/crons/revenueWatch.js';

// Minimal D1-compatible fake. It stores only rows written by these alert paths;
// all provider calls are injected and no network requests are possible.
function fakeDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() {
          const row = rows.get(args[0]);
          return row ? { idempotency_key: row.idempotency_key } : null;
        },
        async run() {
          const key = args[0];
          if (key != null) rows.set(key, { idempotency_key: key, values: args, sql });
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

const quietLogger = { error() {}, warn() {}, log() {} };

test('Telegraph alert failure is observable and does not poison idempotency; confirmed retry records message ID', async () => {
  const DB = fakeDb();
  const env = { DB, FOUNDER_CHAT_ID: 'test-chat' };
  const adapters = {
    async loadTelegraphRequests() {
      return [{ id: 7, request_key: 'request-7', attr_content: 'fixture only' }];
    },
    async loadAlertState() { return [...DB.rows.values()]; },
  };
  let sends = 0;
  const failing = { async send() { sends++; return { ok: false, error: 'synthetic provider failure' }; } };
  const first = await runTelegraphMonitor(env, adapters, failing, quietLogger);
  assert.deepEqual({ new_requests: first.new_requests, alerted: first.alerted, failed: first.failed }, { new_requests: 1, alerted: 0, failed: 1 });
  assert.equal(DB.rows.has('telegraph_alert|request-7'), false);

  const success = { async send() { sends++; return { message_id: 9876 }; } };
  const second = await runTelegraphMonitor(env, adapters, success, quietLogger);
  assert.deepEqual({ new_requests: second.new_requests, alerted: second.alerted, failed: second.failed }, { new_requests: 1, alerted: 1, failed: 0 });
  assert.equal(DB.rows.has('telegraph_alert|request-7'), true);

  const third = await runTelegraphMonitor(env, adapters, success, quietLogger);
  assert.deepEqual({ new_requests: third.new_requests, alerted: third.alerted, failed: third.failed }, { new_requests: 0, alerted: 0, failed: 0 });
  assert.equal(sends, 2, 'a confirmed alert must not be sent again');
});

test('Revenue watch treats malformed success as failure and retries until a provider message ID is present', async () => {
  const DB = fakeDb();
  const env = { DB, FOUNDER_CHAT_ID: 'test-chat' };
  const adapters = {
    async checkAgentSouk() { return [{ id: 'synthetic-bounty' }]; },
    async checkDatapoint() { return {}; },
    async checkBountyBook() { return {}; },
    async loadWatchState() { return [...DB.rows.values()]; },
  };
  const malformed = { async send() { return { ok: true }; } };
  const first = await runRevenueWatch(env, adapters, malformed, quietLogger);
  assert.equal(first.events_detected, 1);
  assert.equal(first.alerted, 0);
  assert.equal(first.failed, 1);
  assert.equal(DB.rows.has('watch|alerted|watch|souk|1'), false);

  const success = { async send() { return { provider_message_id: 'tg-fixture-42' }; } };
  const second = await runRevenueWatch(env, adapters, success, quietLogger);
  assert.equal(second.alerted, 1);
  assert.equal(second.failed, 0);
  assert.equal(DB.rows.has('watch|alerted|watch|souk|1'), true);

  const third = await runRevenueWatch(env, adapters, success, quietLogger);
  assert.equal(third.alerted, 0);
  assert.equal(third.failed, 0);
});
