import test from 'node:test';
import assert from 'node:assert/strict';
import { createCleanV1Worker } from '../src/clean-v1/worker.js';
import {
  encodePaymentHeader,
  paymentRequired,
} from '../src/clean-v1/payment.js';

const RESOURCE_URL = 'https://clean-v1.test/x402/clean_v1';
const PAYEE = '0x59Ea688b36464133E71873d8BeE8Fcb3BC369383';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYER = '0x1111111111111111111111111111111111111111';
const NONCE = '0x' + '2'.repeat(64);
const TX = '0x' + 'a'.repeat(64);
const SENTINEL = 'client-file-content-must-never-leave-worker-41d9c2';

function makePaymentPayload(url = RESOURCE_URL) {
  const required = paymentRequired(url);
  return {
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0],
    payload: {
      signature: '0x' + '1'.repeat(130),
      authorization: {
        from: PAYER,
        to: PAYEE,
        value: '10000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: NONCE,
      },
    },
    extensions: {},
  };
}

function paidRequest(paymentPayload, csv = `name\n  Ada  `) {
  return new Request(RESOURCE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'PAYMENT-SIGNATURE': encodePaymentHeader(paymentPayload),
    },
    body: csv,
  });
}

function settlementResponse(overrides = {}) {
  return new Response(JSON.stringify({
    success: true,
    transaction: TX,
    network: 'eip155:8453',
    payer: PAYER,
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function readFacilitatorBody(init) {
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  const body = JSON.parse(init.body);
  assert.equal(body.x402Version, 2);
  assert.equal(body.paymentRequirements.scheme, 'exact');
  assert.equal(body.paymentRequirements.network, 'eip155:8453');
  assert.equal(body.paymentRequirements.amount, '10000');
  assert.equal(body.paymentRequirements.asset.toLowerCase(), USDC.toLowerCase());
  assert.equal(body.paymentRequirements.payTo.toLowerCase(), PAYEE.toLowerCase());
  assert.equal(body.paymentRequirements.extra.assetTransferMethod, 'eip3009');
  assert.equal(body.paymentRequirements.extra.paymentFlow, 'upfront');
  return body;
}

function decodeHeader(value) {
  assert.ok(value, 'expected a payment protocol header');
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

test('402 challenge advertises the exact Base USDC payment requirements', async () => {
  let facilitatorCalls = 0;
  const worker = createCleanV1Worker({
    facilitatorFetch: async () => { facilitatorCalls++; throw new Error('must not be called'); },
  });
  const response = await worker.fetch(new Request(RESOURCE_URL, { method: 'POST' }));
  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), { code: 'PAYMENT_REQUIRED' });
  assert.equal(facilitatorCalls, 0);

  const challenge = decodeHeader(response.headers.get('PAYMENT-REQUIRED'));
  assert.equal(challenge.x402Version, 2);
  assert.equal(challenge.accepts.length, 1);
  assert.deepEqual(challenge.accepts[0], {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '10000',
    asset: USDC,
    payTo: PAYEE,
    maxTimeoutSeconds: 300,
    extra: {
      assetTransferMethod: 'eip3009',
      paymentFlow: 'upfront',
      name: 'USDC',
      version: '2',
    },
  });
});

test('input is cleaned before settlement and delivered only after settlement is confirmed', async () => {
  let settled = false;
  const worker = createCleanV1Worker({
    facilitatorFetch: async (url, init) => {
      assert.equal(url, 'https://facilitator.test/settle');
      const body = await readFacilitatorBody(init);
      assert.deepEqual(body.paymentPayload, makePaymentPayload());
      assert.equal(init.body.includes('  Ada  '), false, 'file data must not be sent to facilitator');
      settled = true;
      return settlementResponse();
    },
  });

  const response = await worker.fetch(
    paidRequest(makePaymentPayload()),
    { FACILITATOR_URL: 'https://facilitator.test' },
  );
  assert.equal(settled, true);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: [{ name: 'Ada' }],
    malformed_rows: [],
    changes: [{ type: 'text_normalized', row: 2, field: 'name' }],
    source_rows: 1,
  });
  const paymentResponse = decodeHeader(response.headers.get('PAYMENT-RESPONSE'));
  assert.deepEqual(paymentResponse, {
    success: true,
    transaction: TX,
    network: 'eip155:8453',
    payer: PAYER,
  });
});

test('a second use of the same EIP-3009 authorization is rejected by settlement', async () => {
  const consumedNonces = new Set();
  let calls = 0;
  const worker = createCleanV1Worker({
    facilitatorFetch: async (_url, init) => {
      calls++;
      const body = await readFacilitatorBody(init);
      const nonce = body.paymentPayload.payload.authorization.nonce;
      if (consumedNonces.has(nonce)) {
        return settlementResponse({
          success: false,
          transaction: '',
          errorReason: 'authorization_already_used',
        });
      }
      consumedNonces.add(nonce);
      return settlementResponse();
    },
  });

  const first = await worker.fetch(
    paidRequest(makePaymentPayload(), 'name\nFirst'),
    { FACILITATOR_URL: 'https://facilitator.test' },
  );
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).data, [{ name: 'First' }]);

  const second = await worker.fetch(
    paidRequest(makePaymentPayload(), `note\n${SENTINEL}`),
    { FACILITATOR_URL: 'https://facilitator.test' },
  );
  assert.equal(calls, 2);
  assert.equal(second.status, 402);
  const secondBody = await second.text();
  assert.equal(secondBody, JSON.stringify({ code: 'PAYMENT_SETTLEMENT_FAILED' }));
  assert.equal(secondBody.includes(SENTINEL), false);
});

test('facilitator rejection never returns the cleaned file', async () => {
  const worker = createCleanV1Worker({
    facilitatorFetch: async (_url, init) => {
      await readFacilitatorBody(init);
      return settlementResponse({
        success: false,
        transaction: '',
        errorReason: 'invalid_or_consumed_authorization',
      });
    },
  });

  const response = await worker.fetch(
    paidRequest(makePaymentPayload(), `note\n${SENTINEL}`),
    { FACILITATOR_URL: 'https://facilitator.test' },
  );
  assert.equal(response.status, 402);
  const body = await response.text();
  assert.equal(body, JSON.stringify({ code: 'PAYMENT_SETTLEMENT_FAILED' }));
  assert.equal(body.includes(SENTINEL), false);
  assert.equal(response.headers.has('PAYMENT-RESPONSE'), false);
});

test('cleaning failure never invokes the facilitator or returns submitted content', async () => {
  let facilitatorCalls = 0;
  const worker = createCleanV1Worker({
    facilitatorFetch: async () => {
      facilitatorCalls++;
      return settlementResponse();
    },
  });

  const response = await worker.fetch(
    paidRequest(makePaymentPayload(), 'note\n' + SENTINEL + '\n"unterminated'),
    { FACILITATOR_URL: 'https://facilitator.test' },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { code: 'CSV_UNTERMINATED_QUOTE' });
  assert.equal(facilitatorCalls, 0);
  assert.equal(response.headers.has('PAYMENT-RESPONSE'), false);
});

test('format, byte-size, and row-count validation fail before facilitator settlement', async () => {
  let facilitatorCalls = 0;
  const worker = createCleanV1Worker({
    facilitatorFetch: async () => {
      facilitatorCalls++;
      return settlementResponse();
    },
  });
  const signature = encodePaymentHeader(makePaymentPayload());

  const invalidFormat = await worker.fetch(new Request(RESOURCE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'PAYMENT-SIGNATURE': signature,
    },
    body: 'not a supported format',
  }), { FACILITATOR_URL: 'https://facilitator.test' });
  assert.equal(invalidFormat.status, 415);
  assert.deepEqual(await invalidFormat.json(), { code: 'INPUT_FORMAT_UNSUPPORTED' });

  const oversized = await worker.fetch(new Request(RESOURCE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'text/csv',
      'PAYMENT-SIGNATURE': signature,
    },
    body: 'name\n' + 'x'.repeat(102401),
  }), { FACILITATOR_URL: 'https://facilitator.test' });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { code: 'FILE_SIZE_LIMIT_EXCEEDED' });

  const tooManyRows = ['name', ...Array.from({ length: 101 }, (_, index) => 'row-' + (index + 1))].join('\n');
  const overRowLimit = await worker.fetch(new Request(RESOURCE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'text/csv',
      'PAYMENT-SIGNATURE': signature,
    },
    body: tooManyRows,
  }), { FACILITATOR_URL: 'https://facilitator.test' });
  assert.equal(overRowLimit.status, 413);
  assert.deepEqual(await overRowLimit.json(), { code: 'ROW_LIMIT_EXCEEDED' });

  assert.equal(facilitatorCalls, 0);
  for (const response of [invalidFormat, oversized, overRowLimit]) {
    assert.equal(response.headers.has('PAYMENT-RESPONSE'), false);
  }
});

test('malformed or mismatched facilitator settlement confirmation fails closed without result delivery', async () => {
  const cases = [
    {
      name: 'HTTP 500',
      fetch: async () => new Response('unavailable', { status: 500 }),
      code: 'PAYMENT_FACILITATOR_UNAVAILABLE',
    },
    {
      name: 'malformed JSON',
      fetch: async () => new Response('not-json', { status: 200 }),
      code: 'PAYMENT_FACILITATOR_BAD_RESPONSE',
    },
    {
      name: 'mismatched payer',
      fetch: async () => settlementResponse({ payer: '0x2222222222222222222222222222222222222222' }),
      code: 'PAYMENT_SETTLEMENT_UNCONFIRMED',
    },
    {
      name: 'wrong network',
      fetch: async () => settlementResponse({ network: 'eip155:1' }),
      code: 'PAYMENT_SETTLEMENT_UNCONFIRMED',
    },
    {
      name: 'missing transaction hash',
      fetch: async () => settlementResponse({ transaction: '' }),
      code: 'PAYMENT_SETTLEMENT_UNCONFIRMED',
    },
  ];

  for (const scenario of cases) {
    const worker = createCleanV1Worker({ facilitatorFetch: scenario.fetch });
    const response = await worker.fetch(
      paidRequest(makePaymentPayload(), 'note\n' + SENTINEL),
      { FACILITATOR_URL: 'https://facilitator.test' },
    );
    assert.equal(response.status, 503, scenario.name);
    assert.deepEqual(await response.json(), { code: scenario.code }, scenario.name);
    assert.equal(response.headers.has('PAYMENT-RESPONSE'), false, scenario.name);
  }
});

test('file content is not sent to the facilitator, logged, or exposed on facilitator failure', async () => {
  const logged = [];
  const original = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    original[name] = console[name];
    console[name] = (...args) => logged.push(args.map(String).join(' '));
  }

  let facilitatorBody = '';
  try {
    const worker = createCleanV1Worker({
      facilitatorFetch: async (_url, init) => {
        facilitatorBody = init.body;
        throw new Error(SENTINEL);
      },
    });
    const response = await worker.fetch(
      paidRequest(makePaymentPayload(), `note\n${SENTINEL}`),
      { FACILITATOR_URL: 'https://facilitator.test' },
    );
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(body, JSON.stringify({ code: 'PAYMENT_FACILITATOR_UNAVAILABLE' }));
    assert.equal(body.includes(SENTINEL), false);
    assert.equal(facilitatorBody.includes(SENTINEL), false);
    assert.equal(logged.some(line => line.includes(SENTINEL)), false);
  } finally {
    for (const name of Object.keys(original)) console[name] = original[name];
  }
});

test('payment payload with changed price or resource is rejected before facilitator access', async () => {
  let calls = 0;
  const worker = createCleanV1Worker({
    facilitatorFetch: async () => { calls++; return settlementResponse(); },
  });
  const wrongPrice = makePaymentPayload();
  wrongPrice.accepted.amount = '100000';
  const priceResponse = await worker.fetch(paidRequest(wrongPrice));
  assert.equal(priceResponse.status, 402);
  assert.deepEqual(await priceResponse.json(), { code: 'PAYMENT_PAYLOAD_INVALID' });

  const wrongResource = makePaymentPayload('https://attacker.example/x402/clean_v1');
  const resourceResponse = await worker.fetch(paidRequest(wrongResource));
  assert.equal(resourceResponse.status, 402);
  assert.deepEqual(await resourceResponse.json(), { code: 'PAYMENT_PAYLOAD_INVALID' });
  assert.equal(calls, 0);
});
