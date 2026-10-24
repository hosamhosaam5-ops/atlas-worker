import { createOutbox, getTelegramProvider } from '../core/outbox.js';

// Durable retries are persisted in delivery_outbox. Never use timers as a retry
// guarantee in Workers: an invocation can end before a timer fires.
const ALERT_PREFIX = 'x402-settlement-review|';
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [0, 5 * 60_000, 15 * 60_000, 45 * 60_000, 120 * 60_000];

function parseUtc(value) {
  if (!value) return NaN;
  const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T') + 'Z';
  return Date.parse(normalized);
}

function retryEligible(row, now) {
  const attempts = Math.max(0, Number(row.attempts || 0));
  if (attempts >= MAX_ATTEMPTS) return { eligible: false, reason: 'MAX_ATTEMPTS_REACHED' };
  // A timeout/network failure is ambiguous: Telegram may have accepted the message
  // before the response was lost. Avoid auto-resending and creating duplicate alerts.
  if (/timeout|timed out|aborterror|connection reset|network error/i.test(String(row.last_error || ''))) {
    return { eligible: false, reason: 'AMBIGUOUS_DELIVERY_REQUIRES_RECONCILIATION' };
  }
  const updated = parseUtc(row.updated_at || row.created_at);
  const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
  if (Number.isFinite(updated) && now - updated < delay) return { eligible: false, reason: 'BACKOFF' };
  return { eligible: true, reason: 'RETRY_DUE' };
}

export async function retryX402SettlementReviewAlerts(env, dependencies = {}) {
  const db = dependencies.db || env?.DB;
  const logger = dependencies.logger || console;
  if (!db) return { retried: 0, skipped: 0, reason: 'D1_NOT_CONFIGURED' };

  let rows;
  try {
    const result = await db.prepare(
      "SELECT id, dedupe_key, order_id, channel, recipient, subject, body, status, attempts, last_error, created_at, updated_at FROM delivery_outbox WHERE dedupe_key LIKE 'x402-settlement-review|%' AND status IN ('PENDING','FAILED','SENDING') ORDER BY created_at ASC LIMIT 20"
    ).all();
    rows = result?.results || [];
  } catch (error) {
    logger.error('X402_PAYMENT_RECOVERY_ALERT_OUTBOX_READ_FAILED', String(error?.message || error));
    return { retried: 0, skipped: 0, reason: 'OUTBOX_READ_FAILED' };
  }

  const provider = (dependencies.providerFactory || getTelegramProvider)(env);
  const outbox = (dependencies.outboxFactory || createOutbox)(db);
  const now = (dependencies.now || Date.now)();
  let retried = 0;
  let skipped = 0;

  for (const row of rows) {
    if (row.status === 'SENDING') {
      // A crash after provider acceptance but before D1 settlement is uncertain.
      // Never auto-resend this state; it needs manual reconciliation.
      skipped++;
      logger.warn('X402_PAYMENT_RECOVERY_ALERT_REQUIRES_RECONCILIATION', {
        dedupe_key: row.dedupe_key,
        reason: 'DELIVERY_STATE_SENDING_IS_AMBIGUOUS',
      });
      continue;
    }
    const eligibility = retryEligible(row, now);
    if (!eligibility.eligible) {
      skipped++;
      if (eligibility.reason !== 'BACKOFF') {
        logger.warn('X402_PAYMENT_RECOVERY_ALERT_RETRY_SKIPPED', {
          dedupe_key: row.dedupe_key,
          reason: eligibility.reason,
        });
      }
      continue;
    }

    try {
      const result = await outbox.deliver({
        dedupeKey: row.dedupe_key,
        orderId: row.order_id || row.dedupe_key,
        channel: 'telegram',
        recipient: row.recipient,
        text: row.body || '',
        subject: row.subject || undefined,
        provider,
        timeoutMs: Number(env?.TELEGRAM_TIMEOUT_MS || 15000),
        env,
      });
      retried++;
      logger.log('X402_PAYMENT_RECOVERY_ALERT_RETRY_RESULT', {
        dedupe_key: row.dedupe_key,
        delivery_status: result?.delivery_status || 'UNKNOWN',
        attempts: result?.attempts ?? null,
      });
    } catch (error) {
      retried++;
      logger.error('X402_PAYMENT_RECOVERY_ALERT_RETRY_FAILED', {
        dedupe_key: row.dedupe_key,
        error: String(error?.message || error),
      });
    }
  }
  return { retried, skipped };
}

// Notify when this recovery sweep newly flags rows. The minute-bucket key makes
// overlapping Cron invocations idempotent; D1's UNIQUE(dedupe_key) is the final guard.
export async function sendX402SettlementReviewAlert(paymentRecovery, env, dependencies = {}) {
  const reservations = Number(paymentRecovery?.reservations_flagged || 0);
  const missingOrders = Number(paymentRecovery?.settled_without_order_flagged || 0);
  const total = reservations + missingOrders;
  const logger = dependencies.logger || console;

  // Retry previously persisted, definitely failed alerts on every scheduled sweep.
  // This works even when this sweep has no newly flagged payments.
  const retryResult = await retryX402SettlementReviewAlerts(env, dependencies);

  if (total <= 0) return env?.DB
    ? { sent: false, reason: 'NO_NEW_REVIEW_ROWS', retries: retryResult }
    : { sent: false, reason: 'NO_NEW_REVIEW_ROWS' };

  logger.warn('X402_PAYMENT_RECOVERY_REVIEW_REQUIRED', {
    reservations_flagged: reservations,
    settled_without_order_flagged: missingOrders,
  });
  const chatId = String(env?.FOUNDER_CHAT_ID || '').trim();
  if (!chatId) {
    logger.error('X402_PAYMENT_RECOVERY_ALERT_FAILED', 'FOUNDER_CHAT_ID_NOT_CONFIGURED');
    return { sent: false, reason: 'FOUNDER_CHAT_ID_NOT_CONFIGURED' };
  }

  const text = [
    '⚠️ ATLAS: مراجعة تسوية دفع مطلوبة',
    'تم وضع حالات دفع جديدة في SETTLEMENT_REVIEW.',
    'حجوزات قديمة: ' + reservations,
    'تسويات مؤكدة بلا سجل طلب: ' + missingOrders,
    'لم تُفك حجوزات nonce ولم تُعَد أي تسوية تلقائيًا.',
    'يرجى إجراء المطابقة يدويًا قبل أي إجراء مالي.',
  ].join('\n');

  // Production path: persist first, then send through the shared durable outbox.
  // If no DB was injected, retain the provider-only path for isolated unit tests.
  if (env?.DB) {
    try {
      const now = (dependencies.now || Date.now)();
      const dedupeKey = ALERT_PREFIX + Math.floor(now / 60_000) + '|' + reservations + '|' + missingOrders;
      const provider = (dependencies.providerFactory || getTelegramProvider)(env);
      const outbox = (dependencies.outboxFactory || createOutbox)(env.DB);
      const delivery = await outbox.deliver({
        dedupeKey,
        orderId: dedupeKey,
        channel: 'telegram',
        recipient: chatId,
        text,
        provider,
        timeoutMs: Number(env.TELEGRAM_TIMEOUT_MS || 15000),
        env,
      });
      if (delivery?.delivery_status !== 'SENT') {
        logger.error('X402_PAYMENT_RECOVERY_ALERT_FAILED', {
          dedupe_key: dedupeKey,
          delivery_status: delivery?.delivery_status || 'UNKNOWN',
          error: String(delivery?.error || 'TELEGRAM_DELIVERY_NOT_CONFIRMED'),
        });
        return { sent: false, reason: 'DELIVERY_NOT_CONFIRMED', dedupe_key: dedupeKey, delivery_status: delivery?.delivery_status || 'UNKNOWN' };
      }
      logger.log('X402_PAYMENT_RECOVERY_ALERT_SENT', {
        dedupe_key: dedupeKey,
        provider_message_id: delivery.provider_message_id || null,
        reservations_flagged: reservations,
        settled_without_order_flagged: missingOrders,
      });
      return { sent: true, dedupe_key: dedupeKey, provider_message_id: delivery.provider_message_id || null, reservations_flagged: reservations, settled_without_order_flagged: missingOrders };
    } catch (error) {
      logger.error('X402_PAYMENT_RECOVERY_ALERT_FAILED', String(error?.message || error));
      return { sent: false, reason: 'OUTBOX_DELIVERY_EXCEPTION' };
    }
  }

  // Isolated tests only. Production must always use D1-backed delivery_outbox.
  try {
    const telegram = (dependencies.providerFactory || getTelegramProvider)(env);
    const delivery = await telegram.send({ to: chatId, text });
    if (!delivery || delivery.ok !== true) {
      logger.error('X402_PAYMENT_RECOVERY_ALERT_FAILED', {
        error: String(delivery?.error || 'TELEGRAM_DELIVERY_NOT_CONFIRMED'),
        code: String(delivery?.code || 'PROVIDER_ERROR'),
      });
      return { sent: false, reason: 'DELIVERY_NOT_CONFIRMED' };
    }
    logger.log('X402_PAYMENT_RECOVERY_ALERT_SENT', {
      reservations_flagged: reservations,
      settled_without_order_flagged: missingOrders,
    });
    return { sent: true, reservations_flagged: reservations, settled_without_order_flagged: missingOrders };
  } catch (error) {
    logger.error('X402_PAYMENT_RECOVERY_ALERT_FAILED', String(error?.message || error));
    return { sent: false, reason: 'PROVIDER_EXCEPTION' };
  }
}
