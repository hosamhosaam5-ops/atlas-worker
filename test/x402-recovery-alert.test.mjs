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
