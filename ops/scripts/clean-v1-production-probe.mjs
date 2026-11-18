import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { waitForCleanV1PreviewRoute } from './clean-v1-trial-probe.mjs';

export const CLEAN_V1_PREVIEW_PATH = '/x402/clean_v1/preview';
export const CLEAN_V1_PAID_PATH = '/x402/clean_v1';

export function cleanV1ProductionCsv(rowCount) {
  return ['name,value', ...Array.from(
    { length: rowCount },
    (_, index) => 'row-' + (index + 1) + ',' + (index + 1),
  )].join('\n');
}

async function jsonResponse(response, label) {
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(label + '_INVALID_JSON');
  }
  return value;
}

function decodePaymentRequired(value) {
  try {
    const binary = atob(value || '');
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function checkGetPreview(base, fetchImpl) {
  const csv = 'name,value\nget-check,1';
  const url = base + CLEAN_V1_PREVIEW_PATH + '?format=csv&data=' + encodeURIComponent(csv);
  const response = await fetchImpl(url, { method: 'GET' });
  const body = await jsonResponse(response, 'GET_PREVIEW');
  assert.equal(response.status, 200);
  assert.equal(body.preview, true);
  assert.equal(body.source_rows, 1);
  assert.equal(body.preview_rows, 10);
  assert.equal(body.data.length, 1);
  assert.equal(body.truncated, false);
  console.log('PASS | GET preview | HTTP 200 | source_rows=1 | returned_rows=1');
}

async function checkPostPreview(base, rowCount, fetchImpl) {
  const response = await fetchImpl(base + CLEAN_V1_PREVIEW_PATH, {
    method: 'POST',
    headers: { 'content-type': 'text/csv; charset=utf-8' },
    body: cleanV1ProductionCsv(rowCount),
  });
  const body = await jsonResponse(response, 'POST_PREVIEW_' + rowCount);
  const expectedRows = Math.min(rowCount, 10);
  assert.equal(response.status, 200);
  assert.equal(body.preview, true);
  assert.equal(body.source_rows, rowCount);
  assert.equal(body.preview_rows, 10);
  assert.equal(body.data.length, expectedRows);
  assert.equal(body.truncated, rowCount > 10);
  console.log('PASS | POST preview | source_rows=' + rowCount +
    ' | returned_rows=' + body.data.length + ' | truncated=' + body.truncated);
}

async function checkUnpaid402(base, expectedWallet, fetchImpl) {
  // Intentionally no request body, PAYMENT-SIGNATURE, wallet secret, or facilitator call.
  const response = await fetchImpl(base + CLEAN_V1_PAID_PATH, { method: 'POST' });
  const body = await jsonResponse(response, 'UNPAID_402');
  const requirement = decodePaymentRequired(response.headers.get('PAYMENT-REQUIRED'));
  const accepted = requirement?.accepts?.[0];

  assert.equal(response.status, 402);
  assert.equal(body.code, 'PAYMENT_REQUIRED');
  assert.equal(response.headers.has('PAYMENT-RESPONSE'), false);
  assert.equal(requirement?.x402Version, 2);
  assert.equal(accepted?.scheme, 'exact');
  assert.equal(accepted?.network, 'eip155:8453');
  assert.equal(accepted?.amount, '10000');
  assert.equal(String(accepted?.asset || '').toLowerCase(), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  assert.equal(String(accepted?.payTo || '').toLowerCase(), expectedWallet.toLowerCase());
  assert.equal(accepted?.extra?.paymentFlow, 'upfront');
  assert.equal(accepted?.extra?.assetTransferMethod, 'eip3009');
  console.log('PASS | unpaid paid-route challenge | HTTP 402 | no payment sent | approved wallet matches challenge');
}

export async function runCleanV1ProductionProbe(baseUrl, expectedWallet, {
  fetchImpl = fetch,
} = {}) {
  assert.equal(typeof baseUrl, 'string');
  assert.match(baseUrl, /^https:\/\//);
  assert.match(expectedWallet || '', /^0x[a-fA-F0-9]{40}$/);
  const base = baseUrl.replace(/\/+$/, '');

  await waitForCleanV1PreviewRoute(base, { fetchImpl });
  await checkGetPreview(base, fetchImpl);
  await checkPostPreview(base, 10, fetchImpl);
  await checkPostPreview(base, 200, fetchImpl);
  await checkUnpaid402(base, expectedWallet, fetchImpl);
  return { getPreview: true, post10: true, post200: true, unpaid402: true };
}

const invokedAsScript = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  try {
    const [, , baseUrl, wallet] = process.argv;
    await runCleanV1ProductionProbe(baseUrl, wallet);
    console.log('CLEAN_V1_PRODUCTION_SMOKE=PASS');
  } catch (error) {
    console.error('CLEAN_V1_PRODUCTION_SMOKE=FAIL | ' + String(error?.message || error));
    process.exitCode = 1;
  }
}
