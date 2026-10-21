import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createOutbox } from '../src/core/outbox.js';

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
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              const result = sqlite.prepare(sql).run(...args);
              return { meta: { last_row_id: result.lastInsertRowid, changes: result.changes } };
            },
            async first() { return sqlite.prepare(sql).get(...args) ?? null; },
            async all() { return { results: sqlite.prepare(sql).all(...args) }; },
          };
        },
      };
    },
  };
}

test('outbox refuses SENT when provider says ok but omits message ID', async () => {
  const DB = makeD1();
  const outbox = createOutbox(DB);
  const result = await outbox.deliver({
    dedupeKey: 'critical-ops|fixture|missing-id',
    channel: 'telegram',
    recipient: 'test-only-recipient',
    text: 'synthetic test; never sent externally',
    provider: { kind: 'FIXTURE', async send() { return { ok: true }; } },
  });

  assert.equal(result.delivery_status, 'FAILED');
  assert.equal(result.error_code, 'DELIVERY_NOT_CONFIRMED');
  const row = await DB.prepare('SELECT status, attempts, last_error, provider_message_id FROM delivery_outbox WHERE dedupe_key=?')
    .bind('critical-ops|fixture|missing-id').first();
  assert.equal(row.status, 'FAILED');
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /without a message ID/i);
  assert.equal(row.provider_message_id, null);
});

test('outbox refuses SENT when provider message ID is blank', async () => {
  const outbox = createOutbox(makeD1());
  const result = await outbox.deliver({
    dedupeKey: 'critical-ops|fixture|blank-id',
    channel: 'telegram',
    recipient: 'test-only-recipient',
    text: 'synthetic test; never sent externally',
    provider: { kind: 'FIXTURE', async send() { return { ok: true, provider_message_id: '   ' }; } },
  });
  assert.equal(result.delivery_status, 'FAILED');
  assert.equal(result.error_code, 'DELIVERY_NOT_CONFIRMED');
});

test('outbox preserves SENT for provider acknowledgment with a message ID', async () => {
  const outbox = createOutbox(makeD1());
  const result = await outbox.deliver({
    dedupeKey: 'critical-ops|fixture|valid-id',
    channel: 'telegram',
    recipient: 'test-only-recipient',
    text: 'synthetic test; never sent externally',
    provider: { kind: 'FIXTURE', async send() { return { ok: true, provider_message_id: ' fixture-message-7 ' }; } },
  });
  assert.equal(result.delivery_status, 'SENT');
  assert.equal(result.provider_message_id, 'fixture-message-7');
});
