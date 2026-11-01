import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.ATLAS_TEST_BASE_URL || 'http://127.0.0.1:8791';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function upload(input, options, contentType = 'text/csv; charset=utf-8') {
  return fetch(BASE + '/__test/jobs', {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-atlas-cleaning-options': JSON.stringify(options),
    },
    body: input,
  });
}

async function waitForTerminalState(jobId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const response = await fetch(BASE + '/__test/jobs/' + jobId + '/status');
    if (response.status === 404) throw new Error('JOB_DISAPPEARED_BEFORE_DELIVERY');
    assert.equal(response.status, 200);
    last = await response.json();
    if (last.status === 'complete' || last.status === 'failed') return last;
    await delay(100);
  }
  throw new Error('JOB_PROCESSING_TIMEOUT_' + (last?.status || 'unknown'));
}

test('HTTP upload → Queue chunks → Durable Object → engine → delivery → deleted state', async () => {
  const lines = ['id,email,name'];
  for (let i = 1; i <= 5_000; i++) {
    lines.push(i + ', USER' + i + '@EXAMPLE.COM , Name ' + i + ' ');
  }
  const csv = lines.join('\n');
  const inputBytes = encoder.encode(csv);

  const createdResponse = await upload(csv, {
    inputFormat: 'csv',
    outputFormat: 'json',
    operations: [
      { type: 'trim_fields', fields: ['name', 'email'] },
      { type: 'normalize_email', fields: ['email'] },
      { type: 'convert_format', to: 'json' },
    ],
  });

  assert.equal(createdResponse.status, 202);
  const created = await createdResponse.json();
  assert.match(created.jobId, /^[0-9a-f-]{36}$/i);
  assert.equal(created.status, 'queued');
  assert.ok(created.chunks > 1, 'the synthetic input must be split into multiple Queue messages');
  assert.ok(inputBytes.byteLength > 48 * 1024);

  const completed = await waitForTerminalState(created.jobId);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.outputFormat, 'json');
  assert.ok(completed.resultBytes > 0);

  const resultResponse = await fetch(BASE + '/__test/jobs/' + created.jobId + '/result');
  assert.equal(resultResponse.status, 200);
  assert.equal(resultResponse.headers.get('x-atlas-temporary-job-deleted'), 'true');
  assert.match(resultResponse.headers.get('content-type') || '', /application\/json/);

  const output = JSON.parse(decoder.decode(await resultResponse.arrayBuffer()));
  assert.equal(output.length, 5_000);
  assert.equal(output[0].email, 'user1@example.com');
  assert.equal(output[0].name, 'Name 1');
  assert.equal(output[4_999].email, 'user5000@example.com');
  assert.equal(output[4_999].name, 'Name 5000');

  // Verify durable state and result are both absent after the delivery response.
  const statusAfterDelivery = await fetch(BASE + '/__test/jobs/' + created.jobId + '/status');
  assert.equal(statusAfterDelivery.status, 404);
  assert.deepEqual(await statusAfterDelivery.json(), { error: 'JOB_NOT_FOUND' });

  const secondDelivery = await fetch(BASE + '/__test/jobs/' + created.jobId + '/result');
  assert.equal(secondDelivery.status, 404);
  assert.deepEqual(await secondDelivery.json(), { error: 'JOB_NOT_FOUND' });
});

test('malformed CSV travels through Queue and DO, fails closed, and exposes no cell content', async () => {
  const csv = 'name,note\nAda,"private synthetic marker that never closes\n';
  const createdResponse = await upload(csv, { inputFormat: 'csv', operations: [] });
  assert.equal(createdResponse.status, 202);
  const created = await createdResponse.json();

  const state = await waitForTerminalState(created.jobId);
  assert.equal(state.status, 'failed');
  assert.equal(state.errorCode, 'CSV_UNTERMINATED_QUOTE');
  assert.equal(JSON.stringify(state).includes('private synthetic marker'), false);

  const resultResponse = await fetch(BASE + '/__test/jobs/' + created.jobId + '/result');
  assert.equal(resultResponse.status, 422);
  const error = await resultResponse.json();
  assert.equal(error.error, 'CSV_UNTERMINATED_QUOTE');
  assert.equal(JSON.stringify(error).includes('private synthetic marker'), false);
});

test('oversized synthetic upload is rejected before Queue submission', async () => {
  const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
  const response = await upload(oversized, { inputFormat: 'csv', operations: [] });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'FILE_SIZE_LIMIT_EXCEEDED' });
});
