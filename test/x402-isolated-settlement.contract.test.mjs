// Isolated x402 contract tests. No live wallet, facilitator, RPC transaction, or payment is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { x402Requirements } from '../src/autonomy/p1.js';
import { recoverStaleX402Payments } from '../src/orders/x402-recovery.js';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start);
  assert.notEqual(a, -1, `missing source anchor: ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `missing end anchor: ${end}`);
  return source.slice(a, b);
}

test('x402 requirements bind exact Base chain, USDC contract, payTo and 15 USDC amount', () => {
  const req = x402Requirements('https://atlas.test', {
    product_id: 'atlas_test_fixture_data_qa',
    price_usdc: 15,
    wallet: '0x1111111111111111111111111111111111111111',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    network: 'eip155:8453',
  });
  assert.equal(req.x402Version, 2);
  assert.equal(req.accepts.length, 1);
  assert.deepEqual(req.accepts[0], {
    scheme: 'exact', network: 'eip155:8453', amount: '15000000',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x1111111111111111111111111111111111111111',
    maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' },
  });
  assert.equal(req.resource.url, 'https://atlas.test/x402/atlas_test_fixture_data_qa');
});

test('request rejects a mismatched network, token, payTo or amount before nonce reservation', () => {
  const route = section(
    'if ((request.method === "GET" || request.method === "POST") && pathname === "/x402/atlas_ai_data_qa_v1")',
    'if (request.method === "GET" && pathname === "/.well-known/oauth-authorization-server")'
  );
  const match = route.indexOf('const requirementsMatch =');
  const nonce = route.indexOf('const nonce = String(paymentPayload.payload?.authorization?.nonce');
  const claim = route.indexOf('const nonceKey = "x402_nonce|"');
  assert.ok(match >= 0 && nonce > match && claim > nonce);
  const check = route.slice(match, nonce);
  for (const field of ['network', 'asset', 'payTo', 'amount']) assert.ok(check.includes(`accepted.${field}`), `missing ${field} comparison`);
  assert.match(check, /PAYMENT_REQUIREMENTS_MISMATCH/);
});

test('invalid or absent signature is rejected before settlement; nonce is reserved uniquely before verify/settle', () => {
  const route = section(
    'if ((request.method === "GET" || request.method === "POST") && pathname === "/x402/atlas_ai_data_qa_v1")',
    'if (request.method === "GET" && pathname === "/.well-known/oauth-authorization-server")'
  );
  const signature = route.indexOf('const signatureHeader = request.headers.get("PAYMENT-SIGNATURE")');
  const claim = route.indexOf('const nonceKey = "x402_nonce|"');
  const verify = route.indexOf('facilitator + "/verify"');
  const settle = route.indexOf('facilitator + "/settle"');
  assert.ok(signature >= 0 && claim > signature && verify > claim && settle > verify);
  assert.match(route, /PAYMENT-SIGNATURE header is required/);
  assert.match(route, /INVALID_PAYMENT_SIGNATURE/);
  assert.match(route, /PAYMENT_NONCE_ALREADY_USED/);
  assert.match(route, /ON CONFLICT\(idempotency_key\) DO NOTHING/);
  assert.match(route, /"Idempotency-Key": "x402-" \+ nonce/);
});

test('ambiguous settlement retains nonce in SETTLEMENT_REVIEW; it is not released for retry', () => {
  const route = section('let settleResponse;', 'input.tx_hash = String(settleData.transaction);');
  assert.match(route, /settle_request_outcome_unknown/);
  assert.match(route, /SETTLEMENT_REVIEW/);
  assert.doesNotMatch(route, /DELETE FROM execution_state/);
  assert.match(route, /X402_SETTLEMENT_REVIEW_REQUIRED/);
});

function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE execution_state (
      idempotency_key TEXT PRIMARY KEY, record_kind TEXT NOT NULL, status TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}', error_code TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE order_ledger (order_id TEXT PRIMARY KEY);
  `);
  return {
    raw: db,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            run: async () => {
              const result = db.prepare(sql).run(...args);
              return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
            },
            first: async () => db.prepare(sql).get(...args) ?? null,
            all: async () => ({ results: db.prepare(sql).all(...args) }),
          };
        },
        run: async (...args) => {
          const result = db.prepare(sql).run(...args);
          return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
        },
      };
    },
  };
}

test('stale reservations and confirmed settlements missing an order move to review without deleting nonce', async () => {
  const db = makeD1();
  const old = '2000-01-01 00:00:00';
  db.raw.prepare('INSERT INTO execution_state VALUES(?,?,?,?,?,?)').run(
    'x402_nonce|reserved-fixture', 'x402_nonce', 'SETTLEMENT_RESERVED',
    JSON.stringify({ nonce: 'reserved-fixture', product_id: 'atlas_test_fixture_data_qa' }), null, old
  );
  db.raw.prepare('INSERT INTO execution_state VALUES(?,?,?,?,?,?)').run(
    'x402_nonce|settled-fixture', 'x402_nonce', 'SETTLED',
    JSON.stringify({ nonce: 'settled-fixture', product_id: 'atlas_test_fixture_data_qa', tx_hash: '0x1234567890abcdef1234567890abcdef' }), null, old
  );
  const result = await recoverStaleX402Payments(db, 5);
  assert.equal(result.reservations_flagged, 1);
  assert.equal(result.settled_without_order_flagged, 1);
  const rows = db.raw.prepare('SELECT idempotency_key,status,error_code FROM execution_state ORDER BY idempotency_key').all();
  assert.equal(rows.length, 2, 'recovery must preserve both nonce records');
  assert.equal(rows[0].status, 'SETTLEMENT_REVIEW');
  assert.equal(rows[0].error_code, 'STALE_X402_RESERVATION_REQUIRES_RECONCILIATION');
  assert.equal(rows[1].status, 'SETTLEMENT_REVIEW');
  assert.equal(rows[1].error_code, 'X402_SETTLED_ORDER_MISSING_REQUIRES_RECONCILIATION');
});
