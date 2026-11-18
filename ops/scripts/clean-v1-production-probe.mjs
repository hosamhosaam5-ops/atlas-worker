import assert from 'node:assert/strict';

const baseValue = process.env.CLEAN_V1_PROD_BASE_URL;
if (!baseValue) {
  console.log('CLEAN_V1_PROD_PROBE=FAIL | CLEAN_V1_PROD_BASE_URL is missing');
  process.exit(1);
}
const base = new URL(baseValue);
assert.equal(base.protocol, 'https:', 'production base URL must use HTTPS');
assert.equal(base.username, '', 'URL credentials are not allowed');
assert.equal(base.password, '', 'URL credentials are not allowed');
assert.equal(base.search, '', 'base URL must not contain a query');
assert.equal(base.hash, '', 'base URL must not contain a fragment');
const origin = base.toString().replace(/\/+$/, '');

function csvRows(count) {
  const records = ['Full Name,Phone Number,Created Date'];
  for (let index = 1; index <= count; index++) {
    records.push(
      'Customer ' + index + ',+9665000' + String(index).padStart(4, '0') + ',2026-11-18',
    );
  }
  return records.join('\n');
}

async function readJson(response, label) {
  const payload = await response.json().catch(() => null);
  assert.ok(payload && typeof payload === 'object', label + ' did not return JSON');
  return payload;
}

const healthResponse = await fetch(origin + '/health');
const healthPayload = await readJson(healthResponse, 'production health');
assert.equal(healthResponse.status, 200, 'production health must return HTTP 200');
assert.equal(healthPayload.service, 'atlas-clean-v1', 'route must serve isolated Clean v1');
console.log('CLEAN_V1_HEALTH_HTTP=' + healthResponse.status);
console.log('CLEAN_V1_HEALTH_SERVICE=' + healthPayload.service);

const getInput = 'Full Name,Phone Number,Created Date\nCustomer 1,+96650000001,2026-11-18';
const getUrl =
  origin +
  '/x402/clean_v1/preview?format=csv&data=' +
  encodeURIComponent(getInput);
const getResponse = await fetch(getUrl, { method: 'GET' });
const getPayload = await readJson(getResponse, 'preview GET');
assert.equal(getResponse.status, 200, 'preview GET must return HTTP 200');
assert.equal(getPayload.preview, true);
assert.equal(getPayload.source_rows, 1);
console.log('PREVIEW_GET_HTTP=' + getResponse.status);
console.log('PREVIEW_GET_SOURCE_ROWS=' + getPayload.source_rows);

const tenResponse = await fetch(origin + '/x402/clean_v1/preview', {
  method: 'POST',
  headers: { 'content-type': 'text/csv' },
  body: csvRows(10),
});
const tenPayload = await readJson(tenResponse, '10-row preview POST');
assert.equal(tenResponse.status, 200, '10-row preview must return HTTP 200');
assert.equal(tenPayload.source_rows, 10);
assert.equal(tenPayload.data.length, 10);
assert.equal(tenPayload.truncated, false);
console.log('PREVIEW_POST_10_HTTP=' + tenResponse.status);
console.log('PREVIEW_POST_10_SOURCE_ROWS=' + tenPayload.source_rows);
console.log('PREVIEW_POST_10_RETURNED_ROWS=' + tenPayload.data.length);

const twoHundredResponse = await fetch(origin + '/x402/clean_v1/preview', {
  method: 'POST',
  headers: { 'content-type': 'text/csv' },
  body: csvRows(200),
});
const twoHundredPayload = await readJson(twoHundredResponse, '200-row preview POST');
assert.equal(twoHundredResponse.status, 200, '200-row preview must return HTTP 200');
assert.equal(twoHundredPayload.source_rows, 200);
assert.equal(twoHundredPayload.data.length, 10);
assert.equal(twoHundredPayload.truncated, true);
console.log('PREVIEW_POST_200_HTTP=' + twoHundredResponse.status);
console.log('PREVIEW_POST_200_SOURCE_ROWS=' + twoHundredPayload.source_rows);
console.log('PREVIEW_POST_200_RETURNED_ROWS=' + twoHundredPayload.data.length);
console.log('PREVIEW_POST_200_TRUNCATED=' + twoHundredPayload.truncated);

const unpaid = await fetch(origin + '/x402/clean_v1', {
  method: 'POST',
  headers: { 'content-type': 'text/csv' },
  body: csvRows(1),
});
assert.equal(unpaid.status, 402, 'unpaid paid-route request must return HTTP 402');
assert.ok(unpaid.headers.get('PAYMENT-REQUIRED'), 'HTTP 402 must include PAYMENT-REQUIRED');
assert.equal(unpaid.headers.get('PAYMENT-RESPONSE'), null);
console.log('UNPAID_CLEAN_HTTP=' + unpaid.status);
console.log('PAYMENT_REQUIRED_HEADER=PRESENT');
console.log('PAYMENT_RESPONSE_HEADER=ABSENT');
console.log('REAL_PAYMENT_SENT=false');
console.log('CLEAN_V1_PROD_PROBE=PASS');
