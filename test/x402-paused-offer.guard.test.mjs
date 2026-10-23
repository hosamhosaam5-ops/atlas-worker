// x402 fail-closed contract regression tests.
// These checks intentionally do not activate the production offer, contact a facilitator,
// create an order, or submit a payment. They guard the source-level ordering of safety gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
    'const req = x402Requirements(origin, { wallet, asset:'
  );
  assert.match(route, /if\s*\(!wallet\)/);
  assert.match(route, /X402_WALLET_NOT_CONFIGURED/);
  assert.match(route, /return json\(\{ ok: false, error: "X402_WALLET_NOT_CONFIGURED" \}, 503\)/);
  assert.match(route, /String\(product\.status\) !== "ACTIVE"/);
  assert.match(route, /Number\(product\.price_usdc\) !== 15/);
  assert.match(route, /X402_PRODUCT_NOT_READY/);
  assert.ok(route.indexOf('X402_PRODUCT_NOT_READY') < route.indexOf('const req = x402Requirements'),
    'product readiness must be checked before payment requirements are constructed');
});

test('test-mode bootstrap never overwrites an existing paused production product', () => {
  const route = between(
    'if ((request.method === "GET" || request.method === "POST") && pathname === "/x402/atlas_ai_data_qa_v1")',
    'const wallet = String(env.ATLAS_WALLET_ADDRESS || "").trim();'
  );
  assert.match(route, /if \(String\(\(env as any\)\.X402_TEST_MODE \|\| ""\) === "1"\)/);
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
