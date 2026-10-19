// M5 UNIFIED OUTBOX — single delivery engine for ALL channels (telegram + email).
// One ruleset, one table (delivery_outbox), one taxonomy for every send:
//   PENDING -> SENDING -> SENT | FAILED | UNCERTAIN (manual reconciliation only)
//   * Concurrent claim safety: UNIQUE(dedupe_key) at DB level + atomic conditional transition
//     (UPDATE ... WHERE status IN ('PENDING','FAILED')) — concurrent senders resolve to
//     exactly ONE provider-attempt winner per dedupe key. This does NOT claim global
//     exactly-once delivery across a process crash after the provider accepts a message
//     but before D1 is settled; such uncertain SENDING states require reconciliation.
//   * SENT is written ONLY when the channel adapter returns { ok: true }.
//     A throw, a falsy result, ok:false, or a malformed provider response all become
//     FAILED with the error recorded — NEVER a SENT.
//   * Retries are safe: a FAILED row can be re-claimed; a SENT row short-circuits
//     before any provider call (duplicate retry performs ZERO sends).
//
// Channel adapters implement: { kind, async send({to, text, subject, attachments}) ->
//   { ok:true, provider_message_id? } | { ok:false, error, code? } }
//
// Attachments resolve lazily per delivery from the file-storage adapter (LOCAL/R2)
// via {order_id, file_kind} descriptors, so order files are not duplicated into
// the outbox row.

import { getFileStorage } from '../orders/storage.js';

// ---------- M5 Telegram Adapter (moved here from pipeline) ----------
// Contract: send({to, text}) -> {ok:true, provider_message_id} | {ok:false, error, code}
// TELEGRAM_PROVIDER=MOCK (default) performs ZERO network calls.
export function getTelegramProvider(env) {
  const kind = String(env.TELEGRAM_PROVIDER || (env.TELEGRAM_BOT_TOKEN ? 'LIVE' : 'MOCK')).toUpperCase();
  if (kind === 'MOCK') {
    const scenario = env.TELEGRAM_MOCK_SCENARIO || 'success';
    return {
      kind: 'MOCK',
      async send(msg) {
        if (!msg.to) return { ok: false, error: 'missing chat_id', code: 'VALIDATION' };
        if (scenario === 'fail') return { ok: false, error: 'mock telegram failure', code: 'PROVIDER_ERROR' };
        if (scenario === 'rate_limit') return { ok: false, error: 'mock telegram http 429', code: 'RATE_LIMIT' };
        if (scenario === 'timeout') {
          const ms = Number(env.TELEGRAM_TIMEOUT_MS || 10000);
          await new Promise(r => setTimeout(r, ms + 50));
          return { ok: true, provider_message_id: 'mock-late' }; // arrives after timeout — must NOT become SENT
        }
        if (scenario === 'malformed') return { ok: true, provider_message_id: undefined }; // malformed success shape
        return { ok: true, provider_message_id: 'mock-tg-' + Date.now() };
      },
    };
  }
  if (kind === 'LIVE') {
    // Production path — real Bot API. Used only when the founder enters the token as a
    // secret at deploy time. NEVER exercised in M5 local tests.
    return {
      kind: 'LIVE',
      async send(msg) {
        const token = env.TELEGRAM_BOT_TOKEN;
        if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set', code: 'PROVIDER_ERROR' };
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: msg.to, text: msg.text, ...(msg.parse_mode ? { parse_mode: msg.parse_mode } : {}) }),
          signal: AbortSignal.timeout(Number(env.TELEGRAM_TIMEOUT_MS || 15000)),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.ok === true) {
          return { ok: true, provider_message_id: String(data.result && data.result.message_id || '') };
        }
        const code = res.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_ERROR';
        return { ok: false, error: 'telegram api http ' + res.status + (data && data.description ? ': ' + data.description : ''), code };
      },
    };
  }
  throw new Error('unknown TELEGRAM_PROVIDER: ' + kind);
}

// ---------- Generic provider call wrapper: timeout + malformed-shape guard ----------
// A provider resolving with a malformed success shape (no explicit ok:true) is treated
// as FAILED — success must be stated, never assumed.
export async function callProvider(provider, msg, timeoutMs) {
  const ms = timeoutMs || 15000;
  let timer;
  try {
    const res = await Promise.race([
      provider.send(msg),
      new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('provider timeout after ' + ms + 'ms'), { code: 'TIMEOUT' })), ms); }),
    ]);
    if (!res || res.ok !== true) {
      return { ok: false, error: String((res && res.error) || 'provider returned malformed/falsey result'), code: (res && res.code) || 'PROVIDER_ERROR' };
    }
    return { ok: true, provider_message_id: res.provider_message_id || null };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), code: e && e.code === 'TIMEOUT' ? 'TIMEOUT' : 'PROVIDER_ERROR' };
  } finally { clearTimeout(timer); }
}

// ---------- The unified outbox ----------
export function createOutbox(db) {
  // claim-or-resume: returns { row, shouldSend }
  //  - existing SENT       -> shouldSend:false (duplicate retry = zero provider calls)
  //  - existing SENDING    -> shouldSend:false (another runner owns it)
  //  - PENDING/FAILED      -> atomically transition to SENDING; winner sends
  //  - SENDING            -> another runner may own the provider attempt; never send concurrently
  async function claim(dedupeKey, orderId, channel, recipient, subject, body, attachmentNames) {
    await db.prepare(
      "INSERT OR IGNORE INTO delivery_outbox (dedupe_key, order_id, channel, recipient, subject, body, attachment_names, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')"
    ).bind(dedupeKey, orderId ?? dedupeKey, channel, recipient, subject ?? null, body ?? null, (attachmentNames || []).join(',')).run();
    const row = await db.prepare('SELECT * FROM delivery_outbox WHERE dedupe_key = ?').bind(dedupeKey).first();
    if (!row) throw new Error('outbox claim failed for ' + dedupeKey);
    if (row.status === 'SENT') return { row, shouldSend: false, alreadySent: true };
    const upd = await db.prepare(
      "UPDATE delivery_outbox SET status='SENDING', updated_at=datetime('now') WHERE id = ? AND status IN ('PENDING','FAILED')"
    ).bind(row.id).run();
    const changed = upd.meta && (upd.meta.changes !== undefined ? upd.meta.changes : upd.meta.rows_written) || 0;
    return { row, shouldSend: changed > 0, alreadySent: false };
  }

  async function settle(id, ok, attempts, error, providerMessageId, uncertain = false) {
    if (ok) {
      await db.prepare(
        "UPDATE delivery_outbox SET status='SENT', attempts=?, last_error=NULL, provider_message_id=?, updated_at=datetime('now') WHERE id=?"
      ).bind(attempts, providerMessageId ?? null, id).run();
    } else if (uncertain) {
      // Do not automatically retry a send that may already have been accepted.
      await db.prepare(
        "UPDATE delivery_outbox SET status='UNCERTAIN', attempts=?, last_error=?, updated_at=datetime('now') WHERE id=?"
      ).bind(attempts, String(error || 'delivery status uncertain'), id).run();
    } else {
      await db.prepare(
        "UPDATE delivery_outbox SET status='FAILED', attempts=?, last_error=?, updated_at=datetime('now') WHERE id=?"
      ).bind(attempts, String(error || 'unknown'), id).run();
    }
  }

  // deliver: the ONLY way anything is sent in M5+.
  //   { dedupeKey, channel:'telegram'|'email', recipient, text|body, subject,
  //     attachments:[{order_id, file_kind}] , provider, timeoutMs }
  // Returns { delivery_status: 'SENT'|'FAILED'|'SENDING', duplicate, attempts, error? }
  async function deliver(opts) {
    const { dedupeKey, orderId, channel, recipient, text, subject, attachments, provider, timeoutMs } = opts;
    const names = (attachments || []).map(a => (a.file_kind || '') + ':' + (a.file_name || ''));
    const { row, shouldSend, alreadySent } = await claim(dedupeKey, orderId ?? dedupeKey, channel, recipient, subject ?? null, text ?? null, names);
    if (alreadySent) return { delivery_status: 'SENT', duplicate: true, attempts: row.attempts };
    if (!shouldSend) return { delivery_status: row.status === 'SENDING' ? 'SENDING' : row.status, duplicate: true, attempts: row.attempts };

    // resolve attachment bytes from storage (order-scoped files)
    const resolved = [];
    if (attachments && attachments.length) {
      const storage = getFileStorage(opts.env || {});
      for (const a of attachments) {
        const f = a.bytes ? { file_name: a.file_name, bytes: a.bytes } : await storage.get(db, a.order_id, a.file_kind);
        if (f) resolved.push({ file_name: f.file_name || a.file_name, bytes: f.bytes });
      }
    }
    const res = await callProvider(provider, {
      to: recipient, text: text ?? '', subject: subject ?? undefined,
      attachments: resolved, parse_mode: opts.parse_mode,
    }, timeoutMs);
    const attempts = (row.attempts || 0) + 1;
    await settle(row.id, res.ok, attempts, res.error, res.provider_message_id);
    if (res.ok) return { delivery_status: 'SENT', duplicate: false, attempts, provider_message_id: res.provider_message_id };
    return { delivery_status: 'FAILED', duplicate: false, attempts, error: res.error, error_code: res.code || 'PROVIDER_ERROR' };
  }

  return { deliver };
}
