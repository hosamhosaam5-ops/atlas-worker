import { getTelegramProvider } from '../core/outbox.js';

// Notify only for rows newly transitioned into SETTLEMENT_REVIEW by this sweep.
// Subsequent cron runs report zero changed rows and therefore do not resend.
export async function sendX402SettlementReviewAlert(
  paymentRecovery,
  env,
  dependencies = {},
) {
  const reservations = Number(paymentRecovery?.reservations_flagged || 0);
  const missingOrders = Number(paymentRecovery?.settled_without_order_flagged || 0);
  const total = reservations + missingOrders;
  const logger = dependencies.logger || console;
  if (total <= 0) return { sent: false, reason: 'NO_NEW_REVIEW_ROWS' };

  logger.warn('X402_PAYMENT_RECOVERY_REVIEW_REQUIRED', {
    reservations_flagged: reservations,
    settled_without_order_flagged: missingOrders,
  });
  const chatId = String(env?.FOUNDER_CHAT_ID || '').trim();
  if (!chatId) {
    logger.error('X402_PAYMENT_RECOVERY_ALERT_FAILED', 'FOUNDER_CHAT_ID_NOT_CONFIGURED');
    return { sent: false, reason: 'FOUNDER_CHAT_ID_NOT_CONFIGURED' };
  }

  try {
    const providerFactory = dependencies.providerFactory || getTelegramProvider;
    const telegram = providerFactory(env);
    const text = [
      '⚠️ ATLAS: مراجعة تسوية دفع مطلوبة',
      'تم وضع حالات دفع جديدة في SETTLEMENT_REVIEW.',
      'حجوزات قديمة: ' + reservations,
      'تسويات مؤكدة بلا سجل طلب: ' + missingOrders,
      'لم تُفك حجوزات nonce ولم تُعَد أي تسوية تلقائيًا.',
      'يرجى إجراء المطابقة يدويًا قبل أي إجراء مالي.',
    ].join('\\n');
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
