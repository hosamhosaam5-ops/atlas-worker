import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createOutbox } from '../src/core/outbox.js';
import { sendX402SettlementReviewAlert } from '../src/orders/x402-recovery-alert.js';

// This integration fixture uses a real in-memory SQLite engine and the production
// outbox implementation, but a fake provider. It never contacts Telegram or D1 production.
function makeD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE delivery_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      order_id TEXT,
      channel TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      attachment_names TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      provider_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const statement = (sql, args = []) => ({
    async run() {
      const result = sqlite.prepare(sql).run(...args);
      return { meta: { last_row_id: result.lastInsertRowid, changes: result.changes } };
    },
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
  });

  return {
    prepare(sql) {
      return {
        bind(...args) { return statement(sql, args); },
        run: (...args) => statement(sql, args).run(),
        first: (...args) => statement(sql, args).first(),
        all: (...args) => statement(sql, args).all(),
      };
    },
    async read(sql, ...args) { return sqlite.prepare(sql).all(...args); },
  };
}

function makeLogger() {
  const entries = [];
  return {
    entries,
    log: (...args) => entries.push(['log', ...args]),
    warn: (...args) => entries.push(['warn', ...args]),
    error: (...args) => entries.push(['error', ...args]),
  };
}

test('settlement review alert persists SENT and deduplicates through the real outbox', async () => {
  const DB = makeD1();
  const logs = makeLogger();
  const calls = [];
  const now = Date.now();
  const deps = {
    logger: logs,
    now: () => now,
    providerFactory: () => ({
      async send(message) {
        calls.push(message);
        return { ok: true, provider_message_id: 'fixture-telegram-message-42' };
      },
    }),
    outboxFactory: db => createOutbox(db),
  };
  const env = { DB, FOUNDER_CHAT_ID: 'fixture-founder-only' };

  const first = await sendX402SettlementReviewAlert(
    { reservations_flagged: 1, settled_without_order_flagged: 0 }, env, deps,
  );
  const second = await sendX402SettlementReviewAlert(
    { reservations_flagged: 1, settled_without_order_flagged: 0 }, env, deps,
  );

  assert.equal(first.sent, true);
  assert.equal(first.provider_message_id, 'fixture-telegram-message-42');
  assert.equal(second.sent, true);
  assert.equal(calls.length, 1, 'same minute-bucket dedupe key must not send twice');

  const rows = await DB.read(
    "SELECT status, attempts, recipient, provider_message_id, dedupe_key FROM delivery_outbox WHERE dedupe_key LIKE 'x402-settlement-review|%'",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'SENT');
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].recipient, 'fixture-founder-only');
  assert.equal(rows[0].provider_message_id, 'fixture-telegram-message-42');
  assert.match(rows[0].dedupe_key, /^x402-settlement-review\\|/);
});

test('definite Telegram failure is persisted FAILED then retried to SENT without new review rows', async () => {
  const DB = makeD1();
  const logs = makeLogger();
  const calls = [];
  const env = { DB, FOUNDER_CHAT_ID: 'fixture-founder-only' };
  const deps = {
    logger: logs,
    now: () => Date.now(),
    providerFactory: () => ({
      async send(message) {
        calls.push(message);
        if (calls.length === 1) return { ok: false, error: 'telegram api http 429', code: 'RATE_LIMIT' };
        return { ok: true, provider_message_id: 'fixture-retry-message-43' };
      },
    }),
    outboxFactory: db => createOutbox(db),
  };

  const first = await sendX402SettlementReviewAlert(
    { reservations_flagged: 0, settled_without_order_flagged: 1 }, env, deps,
  );
  assert.equal(first.sent, false);
  assert.equal(first.reason, 'DELIVERY_NOT_CONFIRMED');

  let rows = await DB.read(
    "SELECT status, attempts, last_error, provider_message_id FROM delivery_outbox WHERE dedupe_key LIKE 'x402-settlement-review|%'",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'FAILED');
  assert.equal(rows[0].attempts, 1);
  assert.match(rows[0].last_error, /429/);
  assert.equal(rows[0].provider_message_id, null);

  // Ensure retry backoff has elapsed while leaving the original persisted row untouched.
  deps.now = () => Date.now() + 10 * 60_000;
  const retry = await sendX402SettlementReviewAlert(
    { reservations_flagged: 0, settled_without_order_flagged: 0 }, env, deps,
  );
  assert.equal(retry.reason, 'NO_NEW_REVIEW_ROWS');
  assert.equal(retry.retries.retried, 1);
  assert.equal(calls.length, 2);

  rows = await DB.read(
    "SELECT status, attempts, last_error, provider_message_id FROM delivery_outbox WHERE dedupe_key LIKE 'x402-settlement-review|%'",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'SENT');
  assert.equal(rows[0].attempts, 2);
  assert.equal(rows[0].last_error, null);
  assert.equal(rows[0].provider_message_id, 'fixture-retry-message-43');
});
