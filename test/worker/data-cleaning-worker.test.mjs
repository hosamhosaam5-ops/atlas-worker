import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';

const scriptPath = resolve('src/data-cleaning/worker.js');
const mf = new Miniflare({
  workers: [{
    name: 'atlas-cleaning-test',
    scriptPath,
    modules: true,
    compatibilityDate: '2026-10-31',
    durableObjects: { JOB_STATE: 'JobState' },
    queueProducers: ['ATLAS_CLEANING_QUEUE'],
    bindings: { TEST_MODE: '1' },
  }],
});

after(async () => {
  await mf.dispose();
});

const encode = value => new TextEncoder().encode(value);
const decode = value => new TextDecoder().decode(value);
const CHUNK_BYTES = 48 * 1024;

function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function makeQueueMessages(jobId, inputBytes) {
  const totalChunks = Math.max(1, Math.ceil(inputBytes.byteLength / CHUNK_BYTES));
  return Array.from({ length: totalChunks }, (_, index) => ({
    id: 'synthetic-message-' + index,
    timestamp: new Date(),
    attempts: 1,
    body: {
      jobId,
      index,
      totalChunks,
      payload: toBase64(inputBytes.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, inputBytes.byteLength))),
    },
    acked: false,
    retried: false,
    ack() { this.acked = true; },
    retry() { this.retried = true; },
  }));
}

async function submit(csv, options) {
  const response = await mf.dispatchFetch('http://localhost/__test/jobs', {
    method: 'POST',
    headers: {
      'content-type': 'text/csv',
      'x-atlas-cleaning-options': JSON.stringify(options),
    },
    body: csv,
  });
  assert.equal(response.status, 202);
  return response.json();
}

async function deliverQueue(jobId, csv) {
  const messages = makeQueueMessages(jobId, encode(csv));
  const worker = await mf.getWorker('atlas-cleaning-test');
  await worker.queue('atlas-data-cleaning-local', messages);
  assert.equal(messages.every(message => message.acked && !message.retried), true);
  return messages.length;
}

test('Miniflare integration: Queue chunks → Durable Object → deterministic engine → one-time delivery cleanup', async () => {
  const rows = ['id,email,name'];
  for (let i = 1; i <= 5000; i++) {
    rows.push(i + ', USER' + i + '@EXAMPLE.COM , Name ' + i + ' ');
  }
  const csv = rows.join('\n');
  const bytes = encode(csv);
  assert.ok(bytes.byteLength > CHUNK_BYTES, 'fixture must exercise multiple Queue messages');

  const created = await submit(csv, {
    inputFormat: 'csv',
    outputFormat: 'json',
    operations: [
      { type: 'trim_fields', fields: ['name', 'email'] },
      { type: 'normalize_email', fields: ['email'] },
      { type: 'convert_format', to: 'json' },
    ],
  });
  assert.equal(created.status, 'queued');
  assert.ok(created.chunks >= 2);

  const chunkCount = await deliverQueue(created.jobId, csv);
  assert.equal(chunkCount, created.chunks);

  const statusResponse = await mf.dispatchFetch('http://localhost/__test/jobs/' + created.jobId + '/status');
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.status, 'complete');
  assert.equal(status.outputFormat, 'json');

  const resultResponse = await mf.dispatchFetch('http://localhost/__test/jobs/' + created.jobId + '/result');
  assert.equal(resultResponse.status, 200);
  assert.equal(resultResponse.headers.get('x-atlas-temporary-job-deleted'), 'true');
  const output = JSON.parse(decode(await resultResponse.arrayBuffer()));
  assert.equal(output.length, 5000);
  assert.equal(output[0].email, 'user1@example.com');
  assert.equal(output[4999].name, 'Name 5000');

  const secondDelivery = await mf.dispatchFetch('http://localhost/__test/jobs/' + created.jobId + '/result');
  assert.equal(secondDelivery.status, 404, 'temporary result and job metadata must be deleted after first delivery');
  const statusAfterDelivery = await mf.dispatchFetch('http://localhost/__test/jobs/' + created.jobId + '/status');
  assert.equal(statusAfterDelivery.status, 404);
});

test('Miniflare integration: malformed CSV fails closed and exposes only a stable error code', async () => {
  const csv = 'name,note\nAda,"unterminated\n';
  const created = await submit(csv, { inputFormat: 'csv', operations: [] });
  await deliverQueue(created.jobId, csv);

  const statusResponse = await mf.dispatchFetch('http://localhost/__test/jobs/' + created.jobId + '/status');
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.status, 'failed');
  assert.equal(status.errorCode, 'CSV_UNTERMINATED_QUOTE');
  assert.equal(JSON.stringify(status).includes('unterminated'), false);

  const resultResponse = await mf.dispatchFetch('http://localhost/__test/jobs/' + created.jobId + '/result');
  assert.equal(resultResponse.status, 422);
  assert.equal(decode(await resultResponse.arrayBuffer()).includes('unterminated'), false);
});

test('Miniflare integration: the standalone Worker wrapper is closed without explicit test mode', async () => {
  const guarded = new Miniflare({
    workers: [{
      name: 'atlas-cleaning-guarded',
      scriptPath,
      modules: true,
      compatibilityDate: '2026-10-31',
    }],
  });
  try {
    const response = await guarded.dispatchFetch('http://localhost/__test/jobs', {
      method: 'POST',
      body: 'no external access',
    });
    assert.equal(response.status, 404);
  } finally {
    await guarded.dispose();
  }
});
