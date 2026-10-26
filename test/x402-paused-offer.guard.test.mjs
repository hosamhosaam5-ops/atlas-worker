// x402 fail-closed contract regression tests.
// These checks intentionally do not activate the production offer, contact a facilitator,
// create an order, or submit a payment. They guard the source-level ordering of safety gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPaidOfferReadinessError } from '../src/core/paidOfferReadiness.js';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

function between(start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing source anchor: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end anchor: ${end}`);
  return source.slice(from, to);
}

test('x402 route rejects missing wallet before constructing payment requirements', () => {
  const route = between(
    'if ((request.method === "GET" || request.method === "POST") && pathname === "/x402/atlas_ai_data_qa_v1")',
    'const paymentRequirements = req.accepts[0]'
  );
  assert.match(route, /if\s*\(!wallet\)/);
  assert.match(route, /X402_WALLET_NOT_CONFIGURED/);
  assert.match(route, /return json\(\{ ok: false, error: "X402_WALLET_NOT_CONFIGURED" \}, 503\)/);
  assert.match(route, /String\(product\.status\) !== "ACTIVE"/);
  assert.match(route, /Number\(product\.price_usdc\) !== 15/);
  assert.match(route, /X402_PRODUCT_NOT_READY/);
  assert.match(route, /getPaidOfferReadinessError/);
  assert.match(route, /X402_OFFER_NOT_READY/);
});

test('test-mode bootstrap never overwrites an existing paused production product', () => {
  const route = between(
    'if ((request.method === "GET" || request.method === "POST") && pathname === "/x402/atlas_ai_data_qa_v1")',
    'const wallet = String(env.ATLAS_WALLET_ADDRESS || "").trim();'
  );
  assert.match(route, /isLocalX402TestMode\(env as any, request\.url\)/);
  assert.match(route, /if \(localX402TestMode\)/);
  assert.match(route, /if \(!testProduct\) await upsertProduct/);
  assert.doesNotMatch(route, /UPDATE products SET status\s*=\s*['"]ACTIVE['"]/);
});

test('payment verification and nonce reservation occur after fail-closed product gate', () => {
  const route = between(
    'if ((request.method === "GET" || request.method === "POST") && pathname === "/x402/atlas_ai_data_qa_v1")',
    'if (request.method === "GET" && pathname === "/.well-known/oauth-authorization-server")'
  );
  const productGate = route.indexOf('X402_PRODUCT_NOT_READY');
  const requirements = route.indexOf('const req = x402Requirements');
  const nonceReservation = route.indexOf('const nonceKey = "x402_nonce|"');
  const facilitatorVerify = route.indexOf('facilitator + "/verify"');
  assert.ok(productGate >= 0, 'paused/inactive product gate must exist');
  assert.ok(requirements > productGate, 'payment requirements must follow product gate');
  assert.ok(nonceReservation > requirements, 'nonce reservation must follow product gate');
  assert.ok(facilitatorVerify > nonceReservation, 'facilitator verification must follow nonce reservation');
});


test('paid readiness accepts D1-backed A2A delivery without email and rejects unverified public email delivery', () => {
  const base = {
    PAYMENT_PROVIDER: 'BASE_RPC',
    ATLAS_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
    FILE_STORAGE: 'LOCAL',
    DB: {},
    EMAIL_PROVIDER: 'MOCK',
  };
  assert.equal(getPaidOfferReadinessError({ ...base, DELIVERY_PROVIDER: 'A2A' }), null);
  assert.equal(getPaidOfferReadinessError({ ...base, DELIVERY_PROVIDER: 'EMAIL' }), 'PAID_DELIVERY_PROVIDER_NOT_LIVE');
  assert.equal(getPaidOfferReadinessError({ ...base, DELIVERY_PROVIDER: 'A2A', DB: undefined }), 'PAID_STORAGE_PROVIDER_NOT_READY');
});

test('A2A delivery mode requires a claimed task and matching payment proof before x402 POST', () => {
  const route = between(
    'if ((request.method === "GET" || request.method === "POST") && pathname === "/x402/atlas_ai_data_qa_v1")',
    'if (request.method === "GET" && pathname === "/.well-known/oauth-authorization-server")'
  );
  const contextGate = route.indexOf('A2A_TASK_CONTEXT_REQUIRED');
  const readinessGate = route.indexOf('getPaidOfferReadinessError');
  const nonceReservation = route.indexOf('const nonceKey = "x402_nonce|"');
  assert.ok(contextGate >= 0, 'A2A context gate must exist');
  assert.ok(readinessGate > contextGate, 'A2A context gate must run before paid readiness/payment flow');
  assert.ok(nonceReservation > contextGate, 'A2A context gate must run before nonce reservation');
  assert.match(route, /verifyA2ATaskCapability\(env\.DB, a2aTaskId, signatureForTask\)/);
});
