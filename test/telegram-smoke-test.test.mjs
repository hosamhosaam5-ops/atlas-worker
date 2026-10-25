import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTelegramSmokeTest } from '../src/core/telegram-smoke-test.js';

function fixture({ existing = false, providerResult = { ok: true, provider_message_id: 'tg-123' }, providerThrows = false } = {}) {
  const calls = { sent: [], sql: [], claimCount: 0 };
  const db = {
    prepare(sql) {
      calls.sql.push(sql);
      let params = [];
      return {
        bind(...values) { params = values; return this; },
        async run() {
          if (sql.startsWith('INSERT INTO telegram_test_runs')) {
            calls.claimCount++;
            if (existing || calls.claimCount > 1) throw new Error('unique constraint');
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  };
  const providerFactory = () => ({
    async send(message) {
      calls.sent.push(message);
      if (providerThrows) throw new Error('timeout');
      return providerResult;
    },
  });
  return { calls, db, providerFactory };
}
const env = { TELEGRAM_TEST_TOKEN: 'test-secret', TELEGRAM_BOT_TOKEN: 'bot-secret', FOUNDER_CHAT_ID: 'founder-fixed-id' };
const request = (auth = 'Bearer test-secret', method = 'POST') => new Request('https://atlas.test/internal/telegram-test', { method, headers: { authorization: auth } });

test('rejects unauthenticated and non-POST requests without sending', async () => {
  const f = fixture();
  assert.equal((await handleTelegramSmokeTest(request('Bearer wrong'), env, f)).status, 403);
  assert.equal((await handleTelegramSmokeTest(request('Bearer test-secret', 'GET'), env, f)).status, 405);
  assert.equal(f.calls.sent.length, 0);
});

test('sends only the fixed founder message and returns provider message id', async () => {
  const f = fixture();
  const response = await handleTelegramSmokeTest(request(), env, f);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'SENT');
  assert.equal(body.provider_message_id, 'tg-123');
  assert.deepEqual(f.calls.sent, [{ to: 'founder-fixed-id', text: 'ATLAS Telegram delivery test — no payment or settlement was created.' }]);
  assert.match(f.calls.sent[0].text, /no payment or settlement was created/i);
});

test('does not send again after a one-shot claim already exists', async () => {
  const f = fixture({ existing: true });
  const response = await handleTelegramSmokeTest(request(), env, f);
  assert.equal(response.status, 409);
  assert.equal(f.calls.sent.length, 0);
});

test('marks ambiguous provider exceptions for review and never retries in the same request', async () => {
  const f = fixture({ providerThrows: true });
  const response = await handleTelegramSmokeTest(request(), env, f);
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.status, 'REVIEW_REQUIRED');
  assert.equal(f.calls.sent.length, 1);
});
