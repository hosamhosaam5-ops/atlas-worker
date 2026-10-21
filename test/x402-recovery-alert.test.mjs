import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendX402SettlementReviewAlert } from '../src/orders/x402-recovery-alert.js';

function logger() {
  const entries = [];
  return {
    entries,
    warn: (...args) => entries.push(['warn', ...args]),
    log: (...args) => entries.push(['log', ...args]),
    error: (...args) => entries.push(['error', ...args]),
  };
}

test('review alert sends one bounded founder notice only when new rows were flagged', async () => {
  const logs = logger();
  const calls = [];
  const result = await sendX402SettlementReviewAlert(
    { reservations_flagged: 2, settled_without_order_flagged: 1 },
    { FOUNDER_CHAT_ID: 'founder-test-chat' },
    {
      logger: logs,
      providerFactory: () => ({ send: async message => { calls.push(message); return { ok: true, provider_message_id: 'synthetic-1' }; } }),
    },
  );
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, 'founder-test-chat');
  assert.match(calls[0].text, /SETTLEMENT_REVIEW/);
  assert.match(calls[0].text, /لم تُفك حجوزات nonce ولم تُعَد أي تسوية تلقائيًا/);
  assert.equal(logs.entries.filter(e => e[0] === 'log' && e[1] === 'X402_PAYMENT_RECOVERY_ALERT_SENT').length, 1);
});

test('repeat sweep with no newly flagged rows does not send duplicate notifications', async () => {
  const logs = logger();
  let sends = 0;
  const result = await sendX402SettlementReviewAlert(
    { reservations_flagged: 0, settled_without_order_flagged: 0 },
    { FOUNDER_CHAT_ID: 'founder-test-chat' },
    { logger: logs, providerFactory: () => ({ send: async () => { sends++; return { ok: true }; } }) },
  );
  assert.deepEqual(result, { sent: false, reason: 'NO_NEW_REVIEW_ROWS' });
  assert.equal(sends, 0);
});

test('missing founder destination fails closed without sending', async () => {
  const logs = logger();
  let sends = 0;
  const result = await sendX402SettlementReviewAlert(
    { reservations_flagged: 1, settled_without_order_flagged: 0 },
    {},
    { logger: logs, providerFactory: () => ({ send: async () => { sends++; return { ok: true }; } }) },
  );
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'FOUNDER_CHAT_ID_NOT_CONFIGURED');
  assert.equal(sends, 0);
});

test('provider failure is logged and never reported as delivered', async () => {
  const logs = logger();
  const result = await sendX402SettlementReviewAlert(
    { reservations_flagged: 0, settled_without_order_flagged: 1 },
    { FOUNDER_CHAT_ID: 'founder-test-chat' },
    { logger: logs, providerFactory: () => ({ send: async () => ({ ok: false, error: 'synthetic failure' }) }) },
  );
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'DELIVERY_NOT_CONFIRMED');
  assert.equal(logs.entries.filter(e => e[0] === 'error' && e[1] === 'X402_PAYMENT_RECOVERY_ALERT_FAILED').length, 1);
});


test('production alert is persisted through D1-backed outbox before delivery', async () => {
  const logs = logger();
  const calls = [];
  const db = { prepare: sql => ({ all: async () => ({ results: [] }) }) };
  const result = await sendX402SettlementReviewAlert(
    { reservations_flagged: 1, settled_without_order_flagged: 0 },
    { DB: db, FOUNDER_CHAT_ID: 'founder-test-chat' },
    {
      logger: logs,
      now: () => Date.parse('2026-10-21T12:00:00Z'),
      providerFactory: () => ({ send: async () => ({ ok: true, provider_message_id: 'unused-by-outbox-test' }) }),
      outboxFactory: () => ({ deliver: async opts => { calls.push(opts); return { delivery_status: 'SENT', provider_message_id: 'synthetic-outbox-1', attempts: 1 }; } }),
    },
  );
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].dedupeKey, /^x402-settlement-review\|/);
  assert.equal(calls[0].channel, 'telegram');
  assert.equal(calls[0].recipient, 'founder-test-chat');
  assert.match(calls[0].text, /SETTLEMENT_REVIEW/);
});

test('durable retry sweep retries an eligible definite failure when no new rows are flagged', async () => {
  const logs = logger();
  const calls = [];
  const db = {
    prepare: sql => ({
      async all() {
        assert.match(sql, /delivery_outbox/);
        return { results: [{
          id: 7,
          dedupe_key: 'x402-settlement-review|29700000|1|0',
          order_id: 'x402-settlement-review|29700000|1|0',
          channel: 'telegram',
          recipient: 'founder-test-chat',
          body: 'review needed',
          status: 'FAILED',
          attempts: 1,
          last_error: 'telegram api http 429',
          created_at: '2026-10-21 11:00:00',
          updated_at: '2026-10-21 11:50:00',
        }] };
      },
    }),
  };
  const result = await sendX402SettlementReviewAlert(
    { reservations_flagged: 0, settled_without_order_flagged: 0 },
    { DB: db, FOUNDER_CHAT_ID: 'founder-test-chat' },
    {
      logger: logs,
      now: () => Date.parse('2026-10-21T12:00:00Z'),
      providerFactory: () => ({ send: async () => ({ ok: true, provider_message_id: 'unused' }) }),
      outboxFactory: () => ({ deliver: async opts => { calls.push(opts); return { delivery_status: 'SENT', attempts: 2 }; } }),
    },
  );
  assert.equal(result.reason, 'NO_NEW_REVIEW_ROWS');
  assert.equal(result.retries.retried, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dedupeKey, 'x402-settlement-review|29700000|1|0');
});

test('durable retry sweep does not resend an ambiguous timeout that may already have reached Telegram', async () => {
  const logs = logger();
  let sends = 0;
  const db = {
    prepare: () => ({
      async all() {
        return { results: [{
          id: 8,
          dedupe_key: 'x402-settlement-review|29700001|1|0',
          order_id: 'x402-settlement-review|29700001|1|0',
          channel: 'telegram',
          recipient: 'founder-test-chat',
          body: 'review needed',
          status: 'FAILED',
          attempts: 1,
          last_error: 'provider timeout after 15000ms',
          created_at: '2026-10-21 11:00:00',
          updated_at: '2026-10-21 11:30:00',
        }] };
      },
    }),
  };
  const result = await sendX402SettlementReviewAlert(
    { reservations_flagged: 0, settled_without_order_flagged: 0 },
    { DB: db, FOUNDER_CHAT_ID: 'founder-test-chat' },
    {
      logger: logs,
      now: () => Date.parse('2026-10-21T12:00:00Z'),
      providerFactory: () => ({ send: async () => { sends++; return { ok: true }; } }),
      outboxFactory: () => ({ deliver: async () => { sends++; return { delivery_status: 'SENT' }; } }),
    },
  );
  assert.equal(result.retries.retried, 0);
  assert.equal(result.retries.skipped, 1);
  assert.equal(sends, 0);
  assert.ok(logs.entries.some(e => e[0] === 'warn' && e[1] === 'X402_PAYMENT_RECOVERY_ALERT_RETRY_SKIPPED'));
});
