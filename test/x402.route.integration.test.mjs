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
function signatureFor(requirements, nonce) {
  const accepted = requirements.accepts[0];
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: {
      scheme: accepted.scheme,
      network: accepted.network,
      asset: accepted.asset,
      payTo: accepted.payTo,
      amount: accepted.amount,
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
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ isValid: true, invalidReason: null }));
        return;
      }
      calls.settle.push({ nonce, idempotencyKey: req.headers['idempotency-key'] || null });
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
    'wrangler', 'dev', '--local', '--port', String(WORKER_PORT), '--persist-to', PERSIST,
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
