// Conservative recovery for x402 payment claims interrupted by a Worker crash.
// Never releases a nonce or retries settlement automatically; ambiguous states require reconciliation.
export async function recoverStaleX402Payments(db, staleMinutes = 30) {
  const configured = Number(staleMinutes);
  const threshold = Number.isFinite(configured) ? Math.max(5, configured) : 30;

  // A crash after reservation but before a terminal state leaves the nonce blocked.
  // Promote it to an explicit review state; do not delete the claim.
  const reservations = await db.prepare(
    "UPDATE execution_state SET status='SETTLEMENT_REVIEW', error_code=COALESCE(error_code, 'STALE_X402_RESERVATION_REQUIRES_RECONCILIATION'), updated_at=datetime('now') WHERE record_kind='x402_nonce' AND status='SETTLEMENT_RESERVED' AND updated_at < datetime('now', '-' || ? || ' minutes')"
  ).bind(threshold).run();

  // A crash after a confirmed settlement but before the order ledger is written must
  // not be mistaken for a successful delivery. Derive the same order ID used by /x402.
  const settledWithoutOrder = await db.prepare(
    "UPDATE execution_state SET status='SETTLEMENT_REVIEW', error_code=COALESCE(error_code, 'X402_SETTLED_ORDER_MISSING_REQUIRES_RECONCILIATION'), updated_at=datetime('now') WHERE record_kind='x402_nonce' AND status='SETTLED' AND updated_at < datetime('now', '-' || ? || ' minutes') AND json_valid(payload_json) AND json_extract(payload_json, '$.tx_hash') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM order_ledger WHERE order_id = 'X402-' || substr(json_extract(execution_state.payload_json, '$.tx_hash'), 3, 16))"
  ).bind(threshold).run();

  return {
    stale_minutes: threshold,
    reservations_flagged: Number(reservations.meta?.changes || 0),
    settled_without_order_flagged: Number(settledWithoutOrder.meta?.changes || 0),
  };
}
