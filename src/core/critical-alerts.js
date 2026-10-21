import { createOutbox, getTelegramProvider } from './outbox.js';

const ALERT_PREFIX = 'critical-ops|';
const DEDUPE_WINDOW_MS = 15 * 60 * 1000;

function safeLabel(value, fallback) {
  const label = String(value || fallback).toUpperCase().replace(/[^A-Z0-9_-]/g, '_').slice(0, 64);
  return label || fallback;
}

/**
 * Send a deduplicated critical operational alert to the configured founder chat only.
 * No recipient fallback is allowed: missing founder routing fails closed.
 * Error details are intentionally not included in Telegram text to avoid leaking secrets.
 */
export async function sendCriticalOpsAlert(env, category, code, dependencies = {}) {
  const logger = dependencies.logger || console;
  const chatId = String(env?.FOUNDER_CHAT_ID || '').trim();
  if (!chatId) {
    logger.error('ATLAS_CRITICAL_ALERT_NOT_SENT', { reason: 'FOUNDER_CHAT_ID_NOT_CONFIGURED', category: safeLabel(category, 'UNKNOWN') });
    return { sent: false, reason: 'FOUNDER_CHAT_ID_NOT_CONFIGURED' };
  }
  if (!env?.DB) {
    logger.error('ATLAS_CRITICAL_ALERT_NOT_SENT', { reason: 'D1_NOT_CONFIGURED', category: safeLabel(category, 'UNKNOWN') });
    return { sent: false, reason: 'D1_NOT_CONFIGURED' };
  }

  const safeCategory = safeLabel(category, 'UNKNOWN');
  const safeCode = safeLabel(code, 'UNCLASSIFIED');
  const now = (dependencies.now || Date.now)();
  const bucket = Math.floor(now / DEDUPE_WINDOW_MS);
  const dedupeKey = ALERT_PREFIX + safeCategory + '|' + safeCode + '|' + bucket;
  const text = [
    '🚨 ATLAS: تنبيه تشغيلي حرج',
    'المسار: ' + safeCategory,
    'الرمز: ' + safeCode,
    'يرجى مراجعة سجلات Cloudflare وATLAS.',
    'لم تُنفذ أي معاملة مالية بواسطة هذا التنبيه.',
  ].join('\n');

  try {
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
      logger.error('ATLAS_CRITICAL_ALERT_DELIVERY_FAILED', {
        category: safeCategory,
        code: safeCode,
        delivery_status: delivery?.delivery_status || 'UNKNOWN',
        error_code: delivery?.error_code || 'DELIVERY_NOT_CONFIRMED',
      });
      return { sent: false, reason: 'DELIVERY_NOT_CONFIRMED', dedupe_key: dedupeKey, delivery_status: delivery?.delivery_status || 'UNKNOWN' };
    }
    logger.warn('ATLAS_CRITICAL_ALERT_SENT', {
      category: safeCategory,
      code: safeCode,
      dedupe_key: dedupeKey,
      duplicate: delivery.duplicate === true,
      provider_message_id: delivery.provider_message_id || null,
    });
    return { sent: true, dedupe_key: dedupeKey, duplicate: delivery.duplicate === true, provider_message_id: delivery.provider_message_id || null };
  } catch (error) {
    logger.error('ATLAS_CRITICAL_ALERT_EXCEPTION', {
      category: safeCategory,
      code: safeCode,
      error_code: safeLabel(error?.code, 'PROVIDER_EXCEPTION'),
    });
    return { sent: false, reason: 'DELIVERY_EXCEPTION', dedupe_key: dedupeKey };
  }
}
