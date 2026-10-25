import { getTelegramProvider } from './outbox.js';

const TEST_KEY = 'founder-one-shot-telegram-v1';
const TEST_MESSAGE = 'ATLAS Telegram delivery test — no payment or settlement was created.';

const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

/**
 * Sends exactly one fixed smoke-test message to FOUNDER_CHAT_ID.
 * Auth is independent from the Telegram bot token. The D1 claim is written
 * before provider I/O, so concurrent requests and retries cannot duplicate it.
 * Ambiguous provider outcomes are permanently marked REVIEW_REQUIRED.
 */
export async function handleTelegramSmokeTest(request, env, dependencies = {}) {
  if (request.method !== 'POST') return response({ ok: false, error: 'method_not_allowed' }, 405);
  const expected = String(env?.TELEGRAM_TEST_TOKEN || '');
  const supplied = String(request.headers.get('authorization') || '');
  if (!expected || supplied !== 'Bearer ' + expected) return response({ ok: false, error: 'forbidden' }, 403);
  const recipient = String(env?.FOUNDER_CHAT_ID || '').trim();
  const db = dependencies.db || env?.DB;
  if (!db || !recipient || !env?.TELEGRAM_BOT_TOKEN) {
    return response({ ok: false, error: 'telegram_test_not_configured' }, 503);
  }

  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS telegram_test_runs (test_key TEXT PRIMARY KEY, status TEXT NOT NULL, provider_message_id TEXT, error_code TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT)").run();
  } catch {
    return response({ ok: false, error: 'telegram_test_storage_unavailable' }, 503);
  }

  let claim;
  try {
    claim = await db.prepare("INSERT INTO telegram_test_runs (test_key, status) VALUES (?, 'SENDING')").bind(TEST_KEY).run();
  } catch {
    return response({ ok: false, error: 'telegram_test_already_claimed' }, 409);
  }
  if (Number(claim?.meta?.changes || 0) !== 1) return response({ ok: false, error: 'telegram_test_already_claimed' }, 409);

  try {
    const provider = (dependencies.providerFactory || getTelegramProvider)(env);
    const result = await provider.send({ to: recipient, text: TEST_MESSAGE });
    const messageId = result?.provider_message_id ?? result?.message_id ?? null;
    if (!result?.ok || !messageId) {
      await db.prepare("UPDATE telegram_test_runs SET status='FAILED', error_code=?, finished_at=datetime('now') WHERE test_key=?")
        .bind(String(result?.code || 'TELEGRAM_REJECTED').slice(0, 80), TEST_KEY).run();
      return response({ ok: false, status: 'FAILED', error: 'telegram_delivery_not_confirmed' }, 502);
    }
    await db.prepare("UPDATE telegram_test_runs SET status='SENT', provider_message_id=?, finished_at=datetime('now') WHERE test_key=?")
      .bind(String(messageId).slice(0, 160), TEST_KEY).run();
    return response({ ok: true, status: 'SENT', provider_message_id: String(messageId), recipient, note: 'Telegram API accepted the test message; verify visibility in the founder chat.' });
  } catch (error) {
    // Provider timeout/exception may mean Telegram accepted the message. Do not retry.
    try {
      await db.prepare("UPDATE telegram_test_runs SET status='REVIEW_REQUIRED', error_code='PROVIDER_OUTCOME_AMBIGUOUS', finished_at=datetime('now') WHERE test_key=?")
        .bind(TEST_KEY).run();
    } catch { /* retain the pre-send SENDING claim: it is also non-retryable */ }
    return response({ ok: false, status: 'REVIEW_REQUIRED', error: 'provider_outcome_ambiguous_no_retry' }, 502);
  }
}

export const telegramSmokeTestContract = Object.freeze({ testKey: TEST_KEY, message: TEST_MESSAGE });
