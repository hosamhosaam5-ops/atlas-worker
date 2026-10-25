import { getTelegramProvider } from './outbox.js';

const TEST_KEY = 'founder-one-shot-telegram-v1';
const QUEUED_TEST_KEY = 'founder-one-shot-telegram-v2';
const EXPECTED_BOT_USERNAME = 'my_ai_ceo_bot_bot';
const TEST_MESSAGE = 'ATLAS Telegram delivery test — no payment or settlement was created.';

const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

async function verifyTelegramBot(token, dependencies = {}) {
  if (dependencies.verifyBotIdentity) return dependencies.verifyBotIdentity(token);
  try {
    const res = await fetch('https://api.telegram.org/bot' + token + '/getMe', {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok !== true || !data?.result?.username) {
      return { ok: false, error_code: 'TELEGRAM_BOT_IDENTITY_UNAVAILABLE' };
    }
    return { ok: true, username: String(data.result.username).replace(/^@/, '') };
  } catch {
    return { ok: false, error_code: 'TELEGRAM_BOT_IDENTITY_UNAVAILABLE' };
  }
}

function identityError(identity) {
  if (!identity?.ok) return { status: 503, body: { ok: false, error: 'telegram_bot_identity_unavailable' } };
  if (String(identity.username || '').toLowerCase() !== EXPECTED_BOT_USERNAME) {
    return { status: 409, body: { ok: false, error: 'telegram_bot_identity_mismatch', actual_bot_username: String(identity.username || '').slice(0, 64) } };
  }
  return null;
}

async function deliverFixedTest(env, db, testKey, dependencies = {}) {
  const provider = (dependencies.providerFactory || getTelegramProvider)(env);
  const result = await provider.send({ to: String(env.FOUNDER_CHAT_ID).trim(), text: TEST_MESSAGE });
  const messageId = result?.provider_message_id ?? result?.message_id ?? null;
  if (!result?.ok || !messageId) {
    await db.prepare("UPDATE telegram_test_runs SET status='FAILED', error_code=?, finished_at=datetime('now') WHERE test_key=?")
      .bind(String(result?.code || 'TELEGRAM_REJECTED').slice(0, 80), testKey).run();
    return { ok: false, status: 'FAILED', error: 'telegram_delivery_not_confirmed' };
  }
  await db.prepare("UPDATE telegram_test_runs SET status='SENT', provider_message_id=?, finished_at=datetime('now') WHERE test_key=?")
    .bind(String(messageId).slice(0, 160), testKey).run();
  return { ok: true, status: 'SENT', provider_message_id: String(messageId) };
}

/**
 * Authenticated one-shot HTTP path. Identity preflight is read-only and happens
 * before the permanent claim, allowing a misconfigured bot token to be corrected
 * without consuming the one allowed send.
 */
export async function handleTelegramSmokeTest(request, env, dependencies = {}) {
  if (request.method !== 'POST') return response({ ok: false, error: 'method_not_allowed' }, 405);
  const expected = String(env?.TELEGRAM_TEST_TOKEN || '');
  const supplied = String(request.headers.get('authorization') || '');
  if (!expected || supplied !== 'Bearer ' + expected) return response({ ok: false, error: 'forbidden' }, 403);
  const recipient = String(env?.FOUNDER_CHAT_ID || '').trim();
  const db = dependencies.db || env?.DB;
  const token = String(env?.TELEGRAM_BOT_TOKEN || '');
  if (!db || !recipient || !token) return response({ ok: false, error: 'telegram_test_not_configured' }, 503);

  const identity = await verifyTelegramBot(token, dependencies);
  const blocked = identityError(identity);
  if (blocked) return response(blocked.body, blocked.status);

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
    const result = await deliverFixedTest(env, db, TEST_KEY, dependencies);
    if (!result.ok) return response(result, 502);
    return response({ ...result, recipient, note: 'Telegram API accepted the test message; verify visibility in the founder chat.' });
  } catch {
    // Provider timeout/exception may mean Telegram accepted the message. Never retry.
    try {
      await db.prepare("UPDATE telegram_test_runs SET status='REVIEW_REQUIRED', error_code='PROVIDER_OUTCOME_AMBIGUOUS', finished_at=datetime('now') WHERE test_key=?")
        .bind(TEST_KEY).run();
    } catch { /* retain the pre-send SENDING claim: it is also non-retryable */ }
    return response({ ok: false, status: 'REVIEW_REQUIRED', error: 'provider_outcome_ambiguous_no_retry' }, 502);
  }
}

/**
 * Processes only an explicitly inserted, fixed D1 request. This privileged queue
 * allows the founder's one authorized test to be triggered without exposing a
 * public unauthenticated send route or placing credentials in a URL.
 */
export async function processQueuedTelegramSmokeTest(env, dependencies = {}) {
  const db = dependencies.db || env?.DB;
  const recipient = String(env?.FOUNDER_CHAT_ID || '').trim();
  const token = String(env?.TELEGRAM_BOT_TOKEN || '');
  if (!db) return { processed: false, reason: 'D1_NOT_CONFIGURED' };

  let row;
  try {
    row = await db.prepare("SELECT test_key FROM telegram_test_runs WHERE test_key=? AND status='REQUESTED' LIMIT 1")
      .bind(QUEUED_TEST_KEY).first();
  } catch {
    return { processed: false, reason: 'QUEUE_NOT_CONFIGURED' };
  }
  if (!row) return { processed: false, reason: 'NO_REQUESTED_TEST' };
  if (!recipient || !token) {
    await db.prepare("UPDATE telegram_test_runs SET status='FAILED', error_code='TELEGRAM_TEST_NOT_CONFIGURED', finished_at=datetime('now') WHERE test_key=? AND status='REQUESTED'")
      .bind(QUEUED_TEST_KEY).run();
    return { processed: true, status: 'FAILED', reason: 'TELEGRAM_TEST_NOT_CONFIGURED' };
  }

  const identity = await verifyTelegramBot(token, dependencies);
  const blocked = identityError(identity);
  if (blocked) {
    await db.prepare("UPDATE telegram_test_runs SET status='BLOCKED', error_code=?, finished_at=datetime('now') WHERE test_key=? AND status='REQUESTED'")
      .bind(identity?.ok ? 'BOT_IDENTITY_MISMATCH' : 'BOT_IDENTITY_UNAVAILABLE', QUEUED_TEST_KEY).run();
    return { processed: true, status: 'BLOCKED', reason: identity?.ok ? 'BOT_IDENTITY_MISMATCH' : 'BOT_IDENTITY_UNAVAILABLE' };
  }

  const claim = await db.prepare("UPDATE telegram_test_runs SET status='SENDING' WHERE test_key=? AND status='REQUESTED'")
    .bind(QUEUED_TEST_KEY).run();
  if (Number(claim?.meta?.changes || 0) !== 1) return { processed: false, reason: 'REQUEST_ALREADY_CLAIMED' };
  try {
    const result = await deliverFixedTest(env, db, QUEUED_TEST_KEY, dependencies);
    return { processed: true, ...result };
  } catch {
    try {
      await db.prepare("UPDATE telegram_test_runs SET status='REVIEW_REQUIRED', error_code='PROVIDER_OUTCOME_AMBIGUOUS', finished_at=datetime('now') WHERE test_key=?")
        .bind(QUEUED_TEST_KEY).run();
    } catch { /* leave SENDING claim as non-retryable */ }
    return { processed: true, status: 'REVIEW_REQUIRED', reason: 'PROVIDER_OUTCOME_AMBIGUOUS' };
  }
}
