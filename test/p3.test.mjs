import test from 'node:test';
import assert from 'node:assert/strict';
import { commerceManifest, createCommerceSession, advanceCommerceSession, trustSnapshot } from '../src/autonomy/p3.js';

test('P3 manifest preserves zero-spend and x402 fail-closed posture', () => {
  const m = commerceManifest('https://atlas.example');
  assert.deepEqual(m.lifecycle, ['DISCOVER', 'QUOTE', 'PAY', 'VERIFY', 'EXECUTE', 'DELIVER', 'REPUTATION', 'REPEAT']);
  assert.equal(m.payment.x402_settlement, 'NOT_ACTIVE');
  assert.equal(m.payment.payTo, '0x59Ea688b36464133E71873d8BeE8Fcb3BC369383');
  assert.equal(m.safety.outbound_spend_usdc, 0);
});

test('P3 session enforces sequential lifecycle', async () => {
  let stage = 'DISCOVER';
  const db = {
    prepare(sql) {
      return {
        run: async () => ({}),
        all: async () => ({ results: [] }),
        first: async () => ({ session_id: 'cs_test', product_id: 'atlas_ai_data_qa_v1', stage }),
        bind(...args) {
          if (String(sql).startsWith('UPDATE')) stage = args[0];
          return {
            run: async () => ({}),
            first: async () => ({ session_id: 'cs_test', product_id: 'atlas_ai_data_qa_v1', stage })
          };
        }
      };
    }
  };
  const s = await createCommerceSession(db, { agent_id: 'agent-test' });
  assert.equal(s.stage, 'DISCOVER');
  const a = await advanceCommerceSession(db, { session_id: s.session_id, stage: 'QUOTE' });
  assert.equal(a.stage, 'QUOTE');
  await assert.rejects(() => advanceCommerceSession(db, { session_id: s.session_id, stage: 'DELIVER' }), /INVALID_STAGE_TRANSITION/);
});

test('P3 public trust metrics exclude MOCK and placeholder test orders', async () => {
  const queries = [];
  const db = {
    prepare(sql) {
      queries.push(String(sql));
      return {
        run: async () => ({}),
        bind() { return this; },
        first: async () => {
          if (String(sql).includes("COALESCE(settlement_mode,'MOCK')='MOCK' AND payment_status='PAID'")) return { count: 3 };
          if (String(sql).includes("FROM order_ledger WHERE COALESCE(settlement_mode,'MOCK')!='MOCK'") && !String(sql).includes('status=') && !String(sql).includes('payment_status=')) return { count: 2 };
          if (String(sql).includes("COALESCE(settlement_mode,'MOCK')='MOCK'")) return { count: 12 };
          if (String(sql).includes('reputation_events')) return { count: 0 };
          return { count: 0 };
        },
        all: async () => ({ results: [] })
      };
    }
  };
  const snapshot = await trustSnapshot(db);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.verified, true);
  assert.equal(snapshot.metrics.delivered_orders, 0);
  assert.equal(snapshot.metrics.failed_or_review_orders, 0);
  assert.equal(snapshot.metrics.paid_orders, 0);
  assert.equal(snapshot.metrics.verified_production_orders, 2);
  assert.equal(snapshot.metrics.simulated_orders_excluded, 12);
  assert.equal(snapshot.metrics.simulated_paid_orders_excluded, 3);
  assert.equal(snapshot.recent.length, 0);
  assert.match(snapshot.methodology, /MOCK\/test\/stress records are excluded/);
  assert.ok(queries.some(q => q.includes("COALESCE(settlement_mode,'MOCK')!='MOCK'") && q.includes("NOT LIKE '%@example.invalid'")));
  assert.ok(queries.some(q => q.includes("status IN ('DELIVERY_FAILED','FAILED','REVIEW_REQUIRED','QA_FAILED')")));
});
