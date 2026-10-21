import test from 'node:test';
import assert from 'node:assert/strict';
import { sendCriticalOpsAlert } from '../src/core/critical-alerts.js';

const quietLogger = { error() {}, warn() {} };

test('critical operational alert targets only configured founder and uses durable dedupe key', async () => {
  const deliveries = [];
  const env = { DB: {}, FOUNDER_CHAT_ID: 'founder-chat-only', TELEGRAM_TIMEOUT_MS: '5000' };
  const deps = {
    logger: quietLogger,
    now: () => 1_800_000_000_000,
    providerFactory: () => ({ kind: 'TEST_PROVIDER' }),
    outboxFactory: () => ({ async deliver(options) {
      deliveries.push(options);
      return { delivery_status: 'SENT', duplicate: false, provider_message_id: 'test-message-1' };
    } }),
  };
  const result = await sendCriticalOpsAlert(env, 'revenue-watch', 'telegram delivery failed', deps);
  assert.equal(result.sent, true);
  assert.equal(result.provider_message_id, 'test-message-1');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].recipient, 'founder-chat-only');
  assert.equal(deliveries[0].channel, 'telegram');
  assert.match(deliveries[0].dedupeKey, /^critical-ops\\|REVENUE-WATCH\\|TELEGRAM_DELIVERY_FAILED\\|/);
  assert.doesNotMatch(deliveries[0].text, /token|secret|password/i);
});

test('critical alert fails closed when founder recipient is not configured', async () => {
  let called = false;
  const result = await sendCriticalOpsAlert({ DB: {} }, 'scheduler', 'failed', {
    logger: quietLogger,
    providerFactory: () => { called = true; return {}; },
    outboxFactory: () => { called = true; return {}; },
  });
  assert.deepEqual(result, { sent: false, reason: 'FOUNDER_CHAT_ID_NOT_CONFIGURED' });
  assert.equal(called, false);
});

test('critical alert fails closed when durable D1 outbox is not configured', async () => {
  let called = false;
  const result = await sendCriticalOpsAlert({ FOUNDER_CHAT_ID: 'founder-chat-only' }, 'scheduler', 'failed', {
    logger: quietLogger,
    providerFactory: () => { called = true; return {}; },
    outboxFactory: () => { called = true; return {}; },
  });
  assert.deepEqual(result, { sent: false, reason: 'D1_NOT_CONFIGURED' });
  assert.equal(called, false);
});

test('critical alert reports delivery failure rather than false success', async () => {
  const result = await sendCriticalOpsAlert({ DB: {}, FOUNDER_CHAT_ID: 'founder-chat-only' }, 'scheduler', 'failed', {
    logger: quietLogger,
    providerFactory: () => ({}),
    outboxFactory: () => ({ async deliver() { return { delivery_status: 'FAILED', error_code: 'PROVIDER_ERROR' }; } }),
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'DELIVERY_NOT_CONFIRMED');
});
