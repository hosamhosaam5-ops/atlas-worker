import { processOrder, deliverOrder } from '../src/orders/intake.js';
import { ensureOrderSchema } from '../src/orders/schema.js';
import { ensureAutonomySchema } from '../src/autonomy/registry.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function runSuite(env, runId) {
  const db = env.DB;
  await ensureOrderSchema(db);
  await ensureAutonomySchema(db);

  const suffix = Number(runId).toString(16).padStart(8, '0').slice(-8);
  const txA = '0x' + 'a'.repeat(56) + suffix;
  const txB = '0x' + 'b'.repeat(56) + suffix;
  const email = `it-${runId}@example.invalid`;
  const successId = `IT-${runId}-SUCCESS`;
  const duplicateId = `IT-${runId}-DUPLICATE`;
  const failureId = `IT-${runId}-RECOVERY`;
  const bytes = new TextEncoder().encode('name,score\nalpha,10\nbeta,20\n');
  const assertions = [];
  const check = (name, passed, detail = '') => assertions.push({ name, passed: Boolean(passed), ...(detail ? { detail: String(detail) } : {}) });
  const successEnv = { ...env, PAYMENT_PROVIDER: 'MOCK', PAYMENT_MOCK_SCENARIO: 'valid', EMAIL_PROVIDER: 'MOCK', EMAIL_MOCK_SCENARIO: 'success' };
  const failureEnv = { ...successEnv, EMAIL_MOCK_SCENARIO: 'fail' };

  try {
    await db.prepare("INSERT INTO order_quotes (client_email, agreed_amount, status, product_id) VALUES (?, 1, 'ACTIVE', 'atlas_ai_data_qa_v1')").bind(email).run();

    const first = await processOrder(db, successEnv, {
      client_email: email, tx_hash: txA, __file_name: 'data.csv', __file_bytes: bytes,
      __order_id: successId, __settlement_mode: 'MOCK',
    });
    check('mock payment + quote + QA + delivery completes', first.order_status === 'DELIVERED' && first.payment_status === 'PAID' && String(first.qa_report || '').startsWith('PASS'));
    check('QA preserves expected row counts', first.rows_in === 2 && first.rows_out === 2, `rows_in=${first.rows_in}; rows_out=${first.rows_out}`);
    const firstOutbox = await db.prepare("SELECT status, attempts FROM delivery_outbox WHERE dedupe_key=?").bind(`order|${successId}|email`).first();
    check('successful delivery is persisted as SENT', firstOutbox?.status === 'SENT' && firstOutbox?.attempts === 1);

    const duplicate = await processOrder(db, successEnv, {
      client_email: email, tx_hash: txA, __file_name: 'data.csv', __file_bytes: bytes,
      __order_id: duplicateId, __settlement_mode: 'MOCK',
    });
    check('same payment transaction is rejected on second order', duplicate.order_status === 'DUPLICATE_TX', duplicate.order_status);

    const duplicateDelivery = await deliverOrder(db, successEnv, successId, email, 'integration retry', 'synthetic retry', ['clean_csv', 'qa_report']);
    const afterDuplicateDelivery = await db.prepare("SELECT status, attempts FROM delivery_outbox WHERE dedupe_key=?").bind(`order|${successId}|email`).first();
    check('retry after SENT does not send again', duplicateDelivery.delivery_status === 'SENT' && duplicateDelivery.duplicate === true && afterDuplicateDelivery?.attempts === 1);

    const failed = await processOrder(db, failureEnv, {
      client_email: email, tx_hash: txB, __file_name: 'data.csv', __file_bytes: bytes,
      __order_id: failureId, __test_mode: true, __settlement_mode: 'MOCK',
    });
    const failedOutbox = await db.prepare("SELECT status, attempts, last_error FROM delivery_outbox WHERE dedupe_key=?").bind(`order|${failureId}|email`).first();
    check('provider failure is recorded as DELIVERY_FAILED', failed.order_status === 'DELIVERY_FAILED' && failedOutbox?.status === 'FAILED' && failedOutbox?.attempts === 1, failed.order_status);

    const recovered = await deliverOrder(db, successEnv, failureId, email, 'integration recovery', 'synthetic recovery', ['clean_csv', 'qa_report']);
    const recoveredOutbox = await db.prepare("SELECT status, attempts, provider_message_id FROM delivery_outbox WHERE dedupe_key=?").bind(`order|${failureId}|email`).first();
    check('failed outbox retries to SENT with a second attempt', recovered.delivery_status === 'SENT' && recovered.attempts === 2 && recoveredOutbox?.status === 'SENT' && recoveredOutbox?.attempts === 2 && Boolean(recoveredOutbox?.provider_message_id));

    const syntheticLedger = await db.prepare("SELECT COUNT(*) AS n FROM order_ledger WHERE order_id IN (?,?,?) AND settlement_mode='MOCK'").bind(successId, duplicateId, failureId).first();
    check('all created ledger rows remain marked MOCK', Number(syntheticLedger?.n || 0) === 2, `mock ledger rows=${syntheticLedger?.n}`);

    return { ok: assertions.every(x => x.passed), run_id: String(runId), isolation: 'Cloudflare D1 test binding; PAYMENT_PROVIDER=MOCK; EMAIL_PROVIDER=MOCK', assertions };
  } finally {
    for (const id of [successId, duplicateId, failureId]) {
      await db.prepare('DELETE FROM order_files WHERE order_id=?').bind(id).run().catch(() => {});
      await db.prepare('DELETE FROM delivery_outbox WHERE order_id=?').bind(id).run().catch(() => {});
      await db.prepare('DELETE FROM order_ledger WHERE order_id=?').bind(id).run().catch(() => {});
      await db.prepare("DELETE FROM event_log WHERE source='order' AND external_id=?").bind(id).run().catch(() => {});
      await db.prepare('DELETE FROM customer_events WHERE entity_id=?').bind(id).run().catch(() => {});
    }
    await db.prepare('DELETE FROM order_quotes WHERE client_email=?').bind(email).run().catch(() => {});
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      try {
        await ensureOrderSchema(env.DB);
        return json({ ok: true, service: 'atlas-isolated-d1-test-worker', database_binding: 'DB' });
      } catch {
        return json({ ok: false, error: 'TEST_DB_SCHEMA_NOT_READY' }, 503);
      }
    }
    if (url.pathname !== '/run' || request.method !== 'POST') return json({ ok: false, error: 'NOT_FOUND' }, 404);
    if (!env.TEST_TOKEN || request.headers.get('authorization') !== `Bearer ${env.TEST_TOKEN}`) return json({ ok: false, error: 'UNAUTHORIZED' }, 401);
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'INVALID_JSON' }, 400); }
    const runId = Number(body?.run_id);
    if (!Number.isSafeInteger(runId) || runId <= 0) return json({ ok: false, error: 'INVALID_RUN_ID' }, 400);
    try {
      const result = await runSuite(env, runId);
      return json(result, result.ok ? 200 : 500);
    } catch (error) {
      return json({ ok: false, error: 'INTEGRATION_SUITE_ERROR', detail: String(error?.message || error) }, 500);
    }
  },
};
