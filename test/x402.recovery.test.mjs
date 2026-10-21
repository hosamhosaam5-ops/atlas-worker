import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverStaleX402Payments } from '../src/orders/x402-recovery.js';

function makeDb(changes = [2, 1]) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              calls.push({ sql, args });
              return { meta: { changes: changes[calls.length - 1] ?? 0 } };
            },
          };
        },
      };
    },
  };
}

test('stale x402 recovery flags reserved claims and settled payments missing an order without unlocking them', async () => {
  const db = makeDb([3, 2]);
  const result = await recoverStaleX402Payments(db, 12);

  assert.deepEqual(result, {
    stale_minutes: 12,
    reservations_flagged: 3,
    settled_without_order_flagged: 2,
  });
  assert.equal(db.calls.length, 2);
  assert.equal(db.calls[0].args[0], 12);
  assert.match(db.calls[0].sql, /record_kind='x402_nonce'/);
  assert.match(db.calls[0].sql, /status='SETTLEMENT_RESERVED'/);
  assert.match(db.calls[0].sql, /status='SETTLEMENT_REVIEW'/);
  assert.match(db.calls[0].sql, /STALE_X402_RESERVATION_REQUIRES_RECONCILIATION/);
  assert.doesNotMatch(db.calls[0].sql, /DELETE FROM execution_state/i);
  assert.match(db.calls[1].sql, /status='SETTLED'/);
  assert.match(db.calls[1].sql, /NOT EXISTS \(SELECT 1 FROM order_ledger/);
  assert.match(db.calls[1].sql, /X402_SETTLED_ORDER_MISSING_REQUIRES_RECONCILIATION/);
  assert.doesNotMatch(db.calls[1].sql, /DELETE FROM execution_state/i);
});

test('stale x402 recovery clamps the threshold to five minutes and defaults invalid input', async () => {
  const short = makeDb([0, 0]);
  assert.equal((await recoverStaleX402Payments(short, 1)).stale_minutes, 5);
  assert.deepEqual(short.calls.map(c => c.args[0]), [5, 5]);

  const invalid = makeDb([0, 0]);
  assert.equal((await recoverStaleX402Payments(invalid, Number.NaN)).stale_minutes, 30);
  assert.deepEqual(invalid.calls.map(c => c.args[0]), [30, 30]);
});
