import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCleaningJob } from '../../src/data-cleaning/engine.js';

const BASE = process.env.ATLAS_TEST_BASE_URL || 'http://127.0.0.1:8791';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function upload(input, options, contentType = 'text/csv; charset=utf-8', extraHeaders = {}) {
  return fetch(BASE + '/__test/jobs', {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-atlas-cleaning-options': JSON.stringify(options),
      ...extraHeaders,
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

test('10,000 rows: HTTP upload → Queue → 250-row compute chunks → DO retry → exact delivery → delete', async () => {
  const lines = ['id,email,name'];
  for (let i = 1; i <= 10_000; i++) {
    const sourceId = i > 1 && i % 250 === 1 ? i - 1 : i;
    lines.push(' ' + sourceId + ' , USER' + sourceId + '@EXAMPLE.COM , Name ' + sourceId + ' ');
  }
  const csv = lines.join('\n');
  const inputBytes = encoder.encode(csv);
  const options = {
    inputFormat: 'csv',
    outputFormat: 'json',
    chunkRows: 250,
    operations: [
      { type: 'trim_fields', fields: ['id', 'email', 'name'] },
      { type: 'normalize_email', fields: ['email'] },
      { type: 'dedupe_exact' },
      { type: 'convert_format', to: 'json' },
    ],
  };
  const baseline = executeCleaningJob(inputBytes, { ...options, chunkRows: 10_000 });

  // Inject one transient failure after the middle compute chunk is durably committed.
  const createdResponse = await upload(csv, options, 'text/csv; charset=utf-8', {
    'x-atlas-test-fail-chunk': '19',
  });
  assert.equal(createdResponse.status, 202);
  const created = await createdResponse.json();
  assert.match(created.jobId, /^[0-9a-f-]{36}$/i);
  assert.equal(created.status, 'queued');
  assert.ok(created.chunks > 1, 'the upload must be split into multiple Queue messages');
  assert.ok(inputBytes.byteLength > 48 * 1024);

  const completed = await waitForTerminalState(created.jobId);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.outputFormat, 'json');
  assert.equal(completed.inputRowCount, 10_000);
  assert.equal(completed.outputRowCount, baseline.rowCount);
  assert.equal(completed.processingChunkRows, 250);
  assert.equal(completed.processingChunkCount, 40);
  assert.equal(completed.processedChunkCount, 40);
  assert.equal(completed.chunkMetrics.length, 40);
  assert.equal(completed.processAttempts, 2, 'the queue trigger must be retried exactly once');
  assert.equal(completed.retryCount, 1, 'the injected middle-chunk failure must cause one retry');
  assert.ok(completed.chunkMetrics.every(metric => metric.inputRows <= 250));
  assert.ok(completed.chunkMetrics.every(metric => Number.isFinite(metric.computeMs) && metric.computeMs >= 0));

  const sortedTimes = completed.chunkMetrics.map(metric => metric.computeMs).sort((a, b) => a - b);
  const p95 = sortedTimes[Math.ceil(sortedTimes.length * 0.95) - 1];
  const max = sortedTimes[sortedTimes.length - 1];
  assert.equal(completed.p95ChunkComputeMs, p95);
  assert.equal(completed.maxChunkComputeMs, max);
  assert.ok(p95 < 7, 'P95 chunk compute target is below 7 ms; observed ' + p95 + ' ms');
  assert.ok(max <= 10, 'every chunk must remain at or below 10 ms; observed ' + max + ' ms');

  console.log(
    'DATA_CLEANING_CHUNK_BENCHMARK rows=10000 input_bytes=' + inputBytes.byteLength +
    ' output_bytes=' + baseline.byteLength +
    ' chunk_rows=250 chunk_count=' + completed.processingChunkCount +
    ' p95_compute_ms=' + p95.toFixed(3) +
    ' max_compute_ms=' + max.toFixed(3) +
    ' process_attempts=' + completed.processAttempts +
    ' retry_count=' + completed.retryCount
  );

  const resultResponse = await fetch(BASE + '/__test/jobs/' + created.jobId + '/result');
  assert.equal(resultResponse.status, 200);
  assert.equal(resultResponse.headers.get('x-atlas-temporary-job-deleted'), 'true');
  assert.match(resultResponse.headers.get('content-type') || '', /application\/json/);
  const outputBytes = new Uint8Array(await resultResponse.arrayBuffer());
  assert.deepEqual(outputBytes, baseline.bytes, 'chunked result must be byte-for-byte identical to the unchunked engine result');

  const output = JSON.parse(decoder.decode(outputBytes));
  assert.equal(output.length, baseline.rowCount);
  assert.equal(output[0].email, 'user1@example.com');
  assert.equal(output[0].name, 'Name 1');
  assert.equal(output.at(-1).email, 'user10000@example.com');
  assert.equal(output.at(-1).name, 'Name 10000');

  // Delivery is one-time; both status and result are gone afterward.
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
