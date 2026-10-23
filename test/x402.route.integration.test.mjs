// Isolated integration test: the production X402 HTTP route runs in local Wrangler/D1.
// Only the facilitator boundary is replaced with a deterministic local HTTP mock.
// Never uses a wallet, chain, public facilitator, customer data, or real funds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKER_PORT = 8811;
const FACILITATOR_PORT = 8812;
const BASE = `http://127.0.0.1:${WORKER_PORT}`;
const FACILITATOR = `http://127.0.0.1:${FACILITATOR_PORT}`;
const PERSIST = path.join(ROOT, '.wrangler-x402-e2e');
const WALLET = '0x1111111111111111111111111111111111111111';
let worker;
let facilitator;
const calls = { verify: [], settle: [] };

const csv = 'name,score\nAlice,10\nBob,20\nBob,20\n';
const fileBase64 = Buffer.from(csv).toString('base64');

function txForNonce(nonce) {
  return '0x' + createHash('sha256').update('atlas-test-settlement:' + nonce).digest('hex');
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
async function waitUp(url) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(url);
      if (r.status > 0) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('local endpoint did not start: ' + url);
}
function signatureFor(requirements, nonce, acceptedOverrides = {}) {
  const accepted = requirements.accepts[0];
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: {
      scheme: accepted.scheme,
      network: accepted.network,
      asset: accepted.asset,
      payTo: accepted.payTo,
      amount: accepted.amount,
      ...acceptedOverrides,
    },
    payload: { authorization: { nonce }, testFixture: true },
  })).toString('base64');
}
async function postPaid(nonce, requirements) {
  return fetch(BASE + '/x402/atlas_ai_data_qa_v1', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'PAYMENT-SIGNATURE': signatureFor(requirements, nonce),
    },
    body: JSON.stringify({
      client_email: 'synthetic-agent@example.test',
      file_name: 'x402-route-fixture.csv',
      file_base64: fileBase64,
    }),
  });
}

before(async () => {
  fs.rmSync(PERSIST, { recursive: true, force: true });
  calls.verify.length = 0;
  calls.settle.length = 0;
  facilitator = createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      if (req.method !== 'POST' || !['/verify', '/settle'].includes(req.url)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const nonce = String(body?.paymentPayload?.payload?.authorization?.nonce || '');
      if (req.url === '/verify') {
        calls.verify.push({ nonce, idempotencyKey: req.headers['idempotency-key'] || null });
        // Hold the first verifier response open for the contention fixture so all
        // competing requests overlap the reserved-nonce window.
        if (nonce.startsWith('concurrent-burst-')) await new Promise(resolve => setTimeout(resolve, 150));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(nonce.startsWith('invalid-signature-')
          ? { isValid: false, invalidReason: 'synthetic_invalid_signature' }
          : { isValid: true, invalidReason: null }));
        return;
      }
      calls.settle.push({ nonce, idempotencyKey: req.headers['idempotency-key'] || null });
      if (nonce.startsWith('disconnect-')) {
        // Simulate a transport drop after the request reached the facilitator:
        // the settlement outcome is unknown, so the route must keep the nonce locked.
        req.socket.destroy();
        return;
      }
      if (nonce.startsWith('concurrent-burst-')) await new Promise(resolve => setTimeout(resolve, 150));
      if (nonce.startsWith('uncertain-')) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, errorReason: 'synthetic_unknown_settlement_outcome' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, transaction: txForNonce(nonce) }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
  });
  await new Promise((resolve, reject) => {
    facilitator.once('error', reject);
    facilitator.listen(FACILITATOR_PORT, '127.0.0.1', resolve);
  });

  // Apply the same real schema migration files used by the local route audit.
  for (const f of ['schema.sql', 'schema-m2.sql', 'schema-m3.sql', 'schema-m4.sql', 'schema-m5.sql', 'schema-m6.sql']) {
    execSync(`npx wrangler d1 execute atlas_db --local --persist-to .wrangler-x402-e2e --file ./${f}`, {
      cwd: ROOT, stdio: 'ignore', timeout: 30000,
    });
  }
  worker = spawn('npx', [
    'wrangler', 'dev', '--local', '--test-scheduled', '--port', String(WORKER_PORT), '--persist-to', PERSIST,
    '--var', 'X402_TEST_MODE:1',
    '--var', `X402_FACILITATOR_URL:${FACILITATOR}`,
    '--var', `ATLAS_WALLET_ADDRESS:${WALLET}`,
    '--var', 'EMAIL_PROVIDER:MOCK',
    '--var', 'FILE_STORAGE:LOCAL',
    '--var', 'PAYMENT_PROVIDER:MOCK',
    '--var', 'PAYMENT_MOCK_SCENARIO:valid',
    '--var', 'PAYMENT_MOCK_AMOUNT_USDC:15',
  ], { cwd: ROOT, stdio: 'ignore', detached: true });
  worker.unref();
  await waitUp(BASE + '/health');
});
after(async () => {
  if (worker) {
    try { process.kill(-worker.pid, 'SIGKILL'); } catch { try { worker.kill('SIGKILL'); } catch {} }
  }
  if (facilitator) await new Promise(resolve => facilitator.close(resolve));
  try { execSync('pkill -9 -f "wrangler dev --local --port ' + WORKER_PORT + '" || true', { stdio: 'ignore' }); } catch {}
  fs.rmSync(PERSIST, { recursive: true, force: true });
});

test('real local x402 route verifies, settles through mock facilitator, processes order, and rejects nonce replay', async () => {
  const discovery = await fetch(BASE + '/x402/atlas_ai_data_qa_v1');
  assert.equal(discovery.status, 402);
  const requirements = await discovery.json();
  assert.equal(requirements.x402Version, 2);
  assert.equal(requirements.accepts[0].network, 'eip155:8453');
  assert.equal(requirements.accepts[0].asset.toLowerCase(), '0x833589fc d6edb6e08f4c7c32d4f71b54bda02913'.replaceAll(' ', ''));
  assert.equal(requirements.accepts[0].payTo.toLowerCase(), WALLET.toLowerCase());

  // Invalid data must be rejected before the payment facilitator is called.
  const invalid = await fetch(BASE + '/x402/atlas_ai_data_qa_v1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': signatureFor(requirements, 'invalid-file-nonce') },
    body: JSON.stringify({ client_email: 'synthetic-agent@example.test', file_name: 'bad.exe', file_base64: fileBase64 }),
  });
  assert.equal(invalid.status, 415);
  assert.equal(calls.verify.length, 0);
  assert.equal(calls.settle.length, 0);

  const nonce = 'success-nonce-x402-e2e-001';
  const first = await postPaid(nonce, requirements);
  const firstBody = await first.json();
  assert.equal(first.status, 200, 'x402 route response: ' + JSON.stringify(firstBody));
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.order.order_status, 'DELIVERED');
  assert.equal(firstBody.order.payment_status, 'PAID');
  assert.equal(firstBody.order.rows_in, 3);
  assert.equal(firstBody.order.rows_out, 2);
  assert.match(firstBody.order.qa_report, /duplicates_removed=1/);
  assert.equal(firstBody.payment.transaction, txForNonce(nonce));
  assert.deepEqual(calls.verify.map(x => x.nonce), [nonce]);
  assert.deepEqual(calls.settle.map(x => x.nonce), [nonce]);
  assert.equal(calls.settle[0].idempotencyKey, 'x402-' + nonce);

  // Same authorization nonce cannot reach verify or settle again.
  const replay = await postPaid(nonce, requirements);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, 'PAYMENT_NONCE_ALREADY_USED');
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.settle.length, 1);
});


test('malformed signatures, facilitator-rejected signatures, and mismatched chain/token/payTo/amount fail closed', async () => {
  const discovery = await fetch(BASE + '/x402/atlas_ai_data_qa_v1');
  assert.equal(discovery.status, 402);
  const requirements = await discovery.json();
  const verifyBefore = calls.verify.length;
  const settleBefore = calls.settle.length;

  const malformed = await fetch(BASE + '/x402/atlas_ai_data_qa_v1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': '%%%not-base64%%%' },
    body: JSON.stringify({ client_email: 'synthetic-agent@example.test', file_name: 'x402-route-fixture.csv', file_base64: fileBase64 }),
  });
  assert.equal(malformed.status, 402);
  assert.equal((await malformed.json()).error, 'INVALID_PAYMENT_SIGNATURE');

  for (const [field, value] of [
    ['network', 'eip155:1'],
    ['asset', '0x2222222222222222222222222222222222222222'],
    ['payTo', '0x3333333333333333333333333333333333333333'],
    ['amount', '1'],
  ]) {
    const response = await fetch(BASE + '/x402/atlas_ai_data_qa_v1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PAYMENT-SIGNATURE': signatureFor(requirements, 'mismatch-' + field, { [field]: value }),
      },
      body: JSON.stringify({ client_email: 'synthetic-agent@example.test', file_name: 'x402-route-fixture.csv', file_base64: fileBase64 }),
    });
    assert.equal(response.status, 402, field + ' mismatch must be rejected');
    assert.equal((await response.json()).error, 'PAYMENT_REQUIREMENTS_MISMATCH');
  }

  const invalidNonce = 'invalid-signature-x402-e2e-005';
  const rejected = await postPaid(invalidNonce, requirements);
  assert.equal(rejected.status, 402);
  assert.equal((await rejected.json()).error, 'PAYMENT_NOT_VERIFIED');
  assert.equal(calls.verify.filter(x => x.nonce === invalidNonce).length, 1);
  assert.equal(calls.settle.filter(x => x.nonce === invalidNonce).length, 0);
  assert.equal(calls.verify.length, verifyBefore + 1, 'only the facilitator-rejected signature may reach verify');
  assert.equal(calls.settle.length, settleBefore, 'no invalid or mismatched payment may reach settle');
});

test('transport disconnect during settlement leaves nonce locked and blocks retry', async () => {
  const discovery = await fetch(BASE + '/x402/atlas_ai_data_qa_v1');
  assert.equal(discovery.status, 402);
  const requirements = await discovery.json();
  const nonce = 'disconnect-settlement-x402-e2e-006';
  const first = await postPaid(nonce, requirements);
  assert.equal(first.status, 503, 'transport loss during settlement must be surfaced as review-required');
  assert.equal((await first.json()).error, 'X402_SETTLEMENT_REVIEW_REQUIRED');
  assert.equal(calls.verify.filter(x => x.nonce === nonce).length, 1);
  assert.equal(calls.settle.filter(x => x.nonce === nonce).length, 1);

  const replay = await postPaid(nonce, requirements);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, 'PAYMENT_NONCE_ALREADY_USED');
  assert.equal(calls.verify.filter(x => x.nonce === nonce).length, 1);
  assert.equal(calls.settle.filter(x => x.nonce === nonce).length, 1);
});

test('uncertain settlement locks the nonce and prevents any second settle attempt', async () => {
  const discovery = await fetch(BASE + '/x402/atlas_ai_data_qa_v1');
  assert.equal(discovery.status, 402);
  const requirements = await discovery.json();
  const nonce = 'uncertain-settlement-x402-e2e-002';
  const first = await postPaid(nonce, requirements);
  assert.equal(first.status, 503);
  assert.equal((await first.json()).error, 'X402_SETTLEMENT_REVIEW_REQUIRED');
  assert.equal(calls.verify.filter(x => x.nonce === nonce).length, 1);
  assert.equal(calls.settle.filter(x => x.nonce === nonce).length, 1);

  const replay = await postPaid(nonce, requirements);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, 'PAYMENT_NONCE_ALREADY_USED');
  assert.equal(calls.verify.filter(x => x.nonce === nonce).length, 1);
  assert.equal(calls.settle.filter(x => x.nonce === nonce).length, 1);
});


test('a burst of concurrent requests with one payment nonce reserves and settles exactly once', async () => {
  const discovery = await fetch(BASE + '/x402/atlas_ai_data_qa_v1');
  assert.equal(discovery.status, 402);
  const requirements = await discovery.json();
  const nonce = 'concurrent-burst-same-nonce-x402-e2e-004';
  const contenders = 12;

  // Delayed mock facilitator responses keep the winning request in-flight while
  // all contenders attempt the same D1 primary-key reservation.
  const responses = await Promise.all(
    Array.from({ length: contenders }, () => postPaid(nonce, requirements)),
  );
  const bodies = await Promise.all(responses.map(r => r.json()));
  const statusCounts = responses.reduce((counts, response) => {
    counts[response.status] = (counts[response.status] || 0) + 1;
    return counts;
  }, {});

  assert.equal(statusCounts[200], 1, 'exactly one contender may complete processing');
  assert.equal(statusCounts[409], contenders - 1, 'every losing contender must be rejected as a nonce replay');
  assert.equal(bodies.filter(body => body?.ok === true).length, 1);
  assert.equal(bodies.filter(body => body?.error === 'PAYMENT_NONCE_ALREADY_USED').length, contenders - 1);
  assert.equal(calls.verify.filter(x => x.nonce === nonce).length, 1, 'verify must run only once');
  assert.equal(calls.settle.filter(x => x.nonce === nonce).length, 1, 'settlement must run only once');
});


function runLocalD1(sql) {
  const quoted = "'" + sql.replace(/'/g, "'\\''") + "'";
  const output = execSync(
    'npx wrangler d1 execute atlas_db --local --persist-to .wrangler-x402-e2e --command ' + quoted + ' --json',
    { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
  );
  return JSON.parse(output);
}

test('scheduled recovery updates real local D1 rows and preserves a settled order with a matching ledger row', async () => {
  const reservedKey = 'x402_nonce|recovery-fixture-reserved-001';
  const missingOrderKey = 'x402_nonce|recovery-fixture-settled-missing-002';
  const matchedOrderKey = 'x402_nonce|recovery-fixture-settled-matched-003';
  const missingTx = '0x' + 'b'.repeat(64);
  const matchedTx = '0x' + 'c'.repeat(64);
  const matchedOrderId = 'X402-' + matchedTx.slice(2, 18);

  // Seed only synthetic rows into the same isolated D1 used by local Wrangler.
  runLocalD1(`
    DELETE FROM execution_state WHERE idempotency_key IN ('${reservedKey}', '${missingOrderKey}', '${matchedOrderKey}');
    DELETE FROM order_ledger WHERE order_id = '${matchedOrderId}';
    INSERT INTO execution_state (idempotency_key, record_kind, status, payload_json, error_code, created_at, updated_at)
      VALUES ('${reservedKey}', 'x402_nonce', 'SETTLEMENT_RESERVED', '{"nonce":"recovery-fixture-reserved-001"}', NULL, datetime('now','-90 minutes'), datetime('now','-90 minutes'));
    INSERT INTO execution_state (idempotency_key, record_kind, status, payload_json, error_code, created_at, updated_at)
      VALUES ('${missingOrderKey}', 'x402_nonce', 'SETTLED', '{"nonce":"recovery-fixture-settled-missing-002","tx_hash":"${missingTx}","product_id":"atlas_ai_data_qa_v1"}', NULL, datetime('now','-90 minutes'), datetime('now','-90 minutes'));
    INSERT INTO execution_state (idempotency_key, record_kind, status, payload_json, error_code, created_at, updated_at)
      VALUES ('${matchedOrderKey}', 'x402_nonce', 'SETTLED', '{"nonce":"recovery-fixture-settled-matched-003","tx_hash":"${matchedTx}","product_id":"atlas_ai_data_qa_v1"}', NULL, datetime('now','-90 minutes'), datetime('now','-90 minutes'));
    INSERT INTO order_ledger (order_id, client_email, tx_hash, product_id, status, settlement_mode, chain_id)
      VALUES ('${matchedOrderId}', 'synthetic-agent@example.test', '${matchedTx}', 'atlas_ai_data_qa_v1', 'DELIVERED', 'REAL', 'eip155:8453');
  `);

  // Wrangler's local scheduled-event hook invokes the actual Worker scheduled handler.
  const recoveryResponse = await fetch(BASE + '/__scheduled?cron=*/5+*+*+*+*');
  assert.equal(recoveryResponse.status, 200, 'Wrangler scheduled-event test hook must invoke the Worker scheduled handler');

  const query = runLocalD1(`
    SELECT idempotency_key, status, error_code FROM execution_state
    WHERE idempotency_key IN ('${reservedKey}', '${missingOrderKey}', '${matchedOrderKey}')
    ORDER BY idempotency_key;
  `);
  const rows = (Array.isArray(query) ? query : query.results || query[0]?.results || [])
    .flatMap(item => item?.results || item?.result || [item])
    .filter(row => row && row.idempotency_key);
  assert.equal(rows.length, 3, 'all three synthetic D1 fixtures must be readable');

  const byKey = Object.fromEntries(rows.map(row => [row.idempotency_key, row]));
  assert.equal(byKey[reservedKey].status, 'SETTLEMENT_REVIEW');
  assert.equal(byKey[reservedKey].error_code, 'STALE_X402_RESERVATION_REQUIRES_RECONCILIATION');
  assert.equal(byKey[missingOrderKey].status, 'SETTLEMENT_REVIEW');
  assert.equal(byKey[missingOrderKey].error_code, 'X402_SETTLED_ORDER_MISSING_REQUIRES_RECONCILIATION');
  assert.equal(byKey[matchedOrderKey].status, 'SETTLED', 'a settled nonce with a matching order must remain unchanged');
  assert.equal(byKey[matchedOrderKey].error_code, null);

  // A second scheduled pass must be idempotent: reviewed rows stay reviewed,
  // and the settled row with a ledger entry remains untouched.
  const secondRecovery = await fetch(BASE + '/__scheduled?cron=*/5+*+*+*+*');
  assert.equal(secondRecovery.status, 200);
  const secondQuery = runLocalD1(`
    SELECT idempotency_key, status, error_code FROM execution_state
    WHERE idempotency_key IN ('${reservedKey}', '${missingOrderKey}', '${matchedOrderKey}')
    ORDER BY idempotency_key;
  `);
  const secondRows = (Array.isArray(secondQuery) ? secondQuery : secondQuery.results || secondQuery[0]?.results || [])
    .flatMap(item => item?.results || item?.result || [item])
    .filter(row => row && row.idempotency_key);
  assert.equal(secondRows.length, 3);
  const secondByKey = Object.fromEntries(secondRows.map(row => [row.idempotency_key, row]));
  assert.deepEqual(
    [secondByKey[reservedKey].status, secondByKey[reservedKey].error_code],
    ['SETTLEMENT_REVIEW', 'STALE_X402_RESERVATION_REQUIRES_RECONCILIATION'],
  );
  assert.deepEqual(
    [secondByKey[missingOrderKey].status, secondByKey[missingOrderKey].error_code],
    ['SETTLEMENT_REVIEW', 'X402_SETTLED_ORDER_MISSING_REQUIRES_RECONCILIATION'],
  );
  assert.deepEqual(
    [secondByKey[matchedOrderKey].status, secondByKey[matchedOrderKey].error_code],
    ['SETTLED', null],
  );
});


// Classification gate: the intentionally paused product must produce the expected
// configuration 503; enabling it in LOCAL D1 only must expose x402 requirements
// (402), without invoking the facilitator or settling a payment.
test('paused product 503 is classified as expected; active local fixture returns x402 requirements', async () => {
  const verifyCountBefore = calls.verify.length;
  const settleCountBefore = calls.settle.length;
  const pause = runLocalD1("UPDATE products SET status='PAUSED' WHERE product_id='atlas_ai_data_qa_v1';");
  assert.ok(pause, 'local D1 pause fixture command must complete');

  try {
    const paused = await fetch(BASE + '/x402/atlas_ai_data_qa_v1');
    assert.equal(paused.status, 503, 'a deliberately paused product is not a server-health success');
    const pausedBody = await paused.json();
    assert.equal(pausedBody.ok, false);
    assert.equal(pausedBody.error, 'X402_PRODUCT_NOT_READY');

    // A paused POST must be rejected before parsing payment data or touching the facilitator.
    const pausedPost = await fetch(BASE + '/x402/atlas_ai_data_qa_v1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(pausedPost.status, 503);
    const pausedPostBody = await pausedPost.json();
    assert.equal(pausedPostBody.error, 'X402_PRODUCT_NOT_READY');
    assert.equal(calls.verify.length, verifyCountBefore, 'paused requests must not invoke payment verification');
    assert.equal(calls.settle.length, settleCountBefore, 'paused requests must never settle payment');

    const activateLocalFixture = runLocalD1("UPDATE products SET status='ACTIVE', price_usdc=15 WHERE product_id='atlas_ai_data_qa_v1';");
    assert.ok(activateLocalFixture, 'local D1 active fixture command must complete');
    const active = await fetch(BASE + '/x402/atlas_ai_data_qa_v1');
    assert.equal(active.status, 402, 'active product must advertise payment requirements without charging');
    const requirements = await active.json();
    assert.equal(requirements.x402Version, 2);
    assert.equal(requirements.accepts[0].network, 'eip155:8453');
    assert.equal(calls.verify.length, verifyCountBefore, 'GET discovery must not call payment verification');
    assert.equal(calls.settle.length, settleCountBefore, 'GET discovery must never settle payment');
  } finally {
    runLocalD1("UPDATE products SET status='PAUSED' WHERE product_id='atlas_ai_data_qa_v1';");
  }
});
