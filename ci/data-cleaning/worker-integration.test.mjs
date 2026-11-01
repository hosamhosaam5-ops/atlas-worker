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


test('30 synthetic files: exact outputs for valid CSV/JSON and fail-closed contracts for invalid inputs', async () => {
  const csvJson = operations => ({
    inputFormat: 'csv',
    outputFormat: 'json',
    operations: [...operations, { type: 'convert_format', to: 'json' }],
  });
  const cases = [
    { name: 'csv-trim', input: 'name,email\n Ada , ADA@EXAMPLE.COM \n', options: csvJson([{ type: 'trim_fields', fields: ['name', 'email'] }]) },
    { name: 'csv-email-normalize', input: 'email\n USER@EXAMPLE.COM \n', options: { ...csvJson([{ type: 'normalize_email', fields: ['email'] }]), delimiter: ',' } },
    { name: 'csv-dedupe', input: 'id,name\n1,Ada\n1,Ada\n2,Lin\n', options: csvJson([{ type: 'dedupe_exact' }]) },
    { name: 'csv-date', input: 'date\n31/01/2026\n', options: { ...csvJson([{ type: 'format_date', fields: ['date'], inputFormat: 'DD/MM/YYYY', outputFormat: 'YYYY-MM-DD' }]), delimiter: ',' } },
    { name: 'csv-number-de', input: 'amount\n1.234,50\n', options: { ...csvJson([{ type: 'normalize_number', fields: ['amount'], locale: 'de-DE' }]), delimiter: ';' } },
    { name: 'csv-empty-null', input: 'name,note\nAda,  \n', options: csvJson([{ type: 'empty_to_null', fields: ['note'] }]) },
    { name: 'csv-rename', input: 'first,last\nAda,Lovelace\n', options: csvJson([{ type: 'rename_fields', mapping: { first: 'given', last: 'family' } }]) },
    { name: 'csv-semicolon', input: 'name;age\nAda;37\n', options: { inputFormat: 'csv', outputFormat: 'csv', operations: [] } },
    { name: 'csv-tab', input: 'name\tage\nAda\t37\n', options: { inputFormat: 'csv', outputFormat: 'csv', operations: [] } },
    { name: 'csv-pipe', input: 'name|age\nAda|37\n', options: { inputFormat: 'csv', outputFormat: 'csv', operations: [] } },
    { name: 'csv-quoted-delimiter', input: 'name,note\nAda,"a,b"\n', options: csvJson([{ type: 'trim_fields', fields: ['name'] }]) },
    { name: 'csv-quoted-newline', input: 'name,note\nAda,"line one\nline two"\n', options: csvJson([]) },
    { name: 'csv-bom', input: '\uFEFFname,email\nAda,ada@example.com\n', options: csvJson([]) },
    { name: 'csv-blank-lines', input: 'name,age\n\nAda,37\n\nLin,29\n', options: csvJson([]) },
    { name: 'csv-validate', input: 'email,age\nada@example.com,37\n,not-a-number\n', options: csvJson([{ type: 'validate', requiredFields: ['email'], fieldTypes: { age: 'number' } }]) },
    { name: 'json-trim', input: '[{"name":" Ada "}]', json: true, options: { inputFormat: 'json', outputFormat: 'json', operations: [{ type: 'trim_fields', fields: ['name'] }] } },
    { name: 'json-email', input: '[{"email":" USER@EXAMPLE.COM "}]', json: true, options: { inputFormat: 'json', outputFormat: 'json', operations: [{ type: 'normalize_email', fields: ['email'] }] } },
    { name: 'json-dedupe', input: '[{"a":1,"b":"x"},{"b":"x","a":1},{"a":2,"b":"y"}]', json: true, options: { inputFormat: 'json', outputFormat: 'json', operations: [{ type: 'dedupe_exact' }] } },
    { name: 'json-extract-path', input: '[{"customer":{"email":"ada@example.com"}}]', json: true, options: { inputFormat: 'json', outputFormat: 'json', operations: [{ type: 'extract_json_paths', paths: { email: 'customer.email' } }] } },
    { name: 'json-empty-null', input: '[{"note":"  ","name":"Ada"}]', json: true, options: { inputFormat: 'json', outputFormat: 'json', operations: [{ type: 'empty_to_null', fields: ['note'] }] } },
    { name: 'json-date', input: '[{"date":"31/01/2026"}]', json: true, options: { inputFormat: 'json', outputFormat: 'json', operations: [{ type: 'format_date', fields: ['date'], inputFormat: 'DD/MM/YYYY', outputFormat: 'YYYY-MM-DD' }] } },
    { name: 'json-number', input: '[{"amount":"1.234,50"}]', json: true, options: { inputFormat: 'json', outputFormat: 'json', operations: [{ type: 'normalize_number', fields: ['amount'], locale: 'de-DE' }] } },
    { name: 'json-rename', input: '[{"first":"Ada","last":"Lovelace"}]', json: true, options: { inputFormat: 'json', outputFormat: 'json', operations: [{ type: 'rename_fields', mapping: { first: 'given', last: 'family' } }] } },
    { name: 'json-validate', input: '[{"email":""},{"email":"ada@example.com"}]', json: true, options: { inputFormat: 'json', outputFormat: 'json', operations: [{ type: 'validate', requiredFields: ['email'] }] } },
    { name: 'json-to-csv', input: '[{"name":"Ada","age":37}]', json: true, options: { inputFormat: 'json', outputFormat: 'csv', operations: [{ type: 'convert_format', to: 'csv' }] } },
  ];

  const validJobs = await Promise.all(cases.map(async item => {
    const inputBytes = encoder.encode(item.input);
    const baseline = executeCleaningJob(inputBytes, { ...item.options, chunkRows: 10_000 });
    const response = await upload(inputBytes, item.options, item.json ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
    assert.equal(response.status, 202, item.name + ' upload');
    const created = await response.json();
    return { item, baseline, jobId: created.jobId };
  }));

  const invalidCases = [
    { name: 'csv-unclosed-quote', input: 'name,note\nAda,"SYNTHETIC_PRIVATE_MARKER', options: { inputFormat: 'csv', outputFormat: 'json', operations: [] }, expected: 'CSV_UNTERMINATED_QUOTE' },
    { name: 'csv-width-mismatch', input: 'a,b,c\n1,2\n', options: { inputFormat: 'csv', outputFormat: 'json', operations: [] }, expected: 'CSV_ROW_WIDTH_MISMATCH' },
    { name: 'json-malformed', input: '[{"name":', options: { inputFormat: 'json', outputFormat: 'json', operations: [] }, expected: 'JSON_PARSE_FAILED' },
    { name: 'csv-row-limit', input: 'id,value\n' + Array.from({ length: 10_001 }, (_, i) => (i + 1) + ',x').join('\n'), options: { inputFormat: 'csv', outputFormat: 'json', operations: [] }, expected: 'ROW_LIMIT_EXCEEDED' },
  ];
  const invalidJobs = await Promise.all(invalidCases.map(async item => {
    const response = await upload(item.input, item.options);
    assert.equal(response.status, 202, item.name + ' upload');
    const created = await response.json();
    return { item, jobId: created.jobId };
  }));

  const validResults = await Promise.all(validJobs.map(async ({ item, baseline, jobId }) => {
    const status = await waitForTerminalState(jobId);
    assert.equal(status.status, 'complete', item.name + ' terminal status');
    const response = await fetch(BASE + '/__test/jobs/' + jobId + '/result');
    assert.equal(response.status, 200, item.name + ' result delivery');
    const output = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(output, baseline.bytes, item.name + ' exact output; no unrequested changes');
    const deleted = await fetch(BASE + '/__test/jobs/' + jobId + '/status');
    assert.equal(deleted.status, 404, item.name + ' temporary state deleted after delivery');
    return true;
  }));

  const invalidResults = await Promise.all(invalidJobs.map(async ({ item, jobId }) => {
    const status = await waitForTerminalState(jobId);
    assert.equal(status.status, 'failed', item.name + ' must fail closed');
    assert.equal(status.errorCode, item.expected, item.name + ' stable error code');
    const response = await fetch(BASE + '/__test/jobs/' + jobId + '/result');
    assert.equal(response.status, 422, item.name + ' no output delivery');
    const body = await response.text();
    assert.equal(body.includes('SYNTHETIC_PRIVATE_MARKER'), false, item.name + ' must not expose cell contents');
    return true;
  }));

  const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
  const oversizedResponse = await upload(oversized, { inputFormat: 'csv', outputFormat: 'json', operations: [] });
  assert.equal(oversizedResponse.status, 413, 'oversized file must be rejected before Queue submission');
  assert.deepEqual(await oversizedResponse.json(), { error: 'FILE_SIZE_LIMIT_EXCEEDED' });

  assert.equal(validResults.length, 25);
  assert.equal(invalidResults.length, 4);
  console.log('DATA_CLEANING_30_FILE_CORPUS valid_exact=' + validResults.length + ' invalid_expected=' + invalidResults.length + ' oversized_rejected=1 total=30');
});


test('public upload requires bearer auth and enforces the durable per-client rate limit', async () => {
  const csv = 'name\nSynthetic\n';
  const options = { inputFormat: 'csv', outputFormat: 'json', delimiter: ',', operations: [{ type: 'convert_format', to: 'json' }] };
  const baseHeaders = {
    'content-type': 'text/csv; charset=utf-8',
    'x-atlas-cleaning-options': JSON.stringify(options),
    'cf-connecting-ip': '198.51.100.44',
  };
  const unauthenticated = await fetch(BASE + '/v1/jobs', { method: 'POST', headers: baseHeaders, body: csv });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: 'UNAUTHORIZED' });

  const wrongToken = await fetch(BASE + '/v1/jobs', {
    method: 'POST',
    headers: { ...baseHeaders, authorization: 'Bearer ' + 'x'.repeat(48) },
    body: csv,
  });
  assert.equal(wrongToken.status, 401);

  const token = 'local-test-token-not-for-production-000000000000';
  const authorizedHeaders = { ...baseHeaders, authorization: 'Bearer ' + token };
  const first = await fetch(BASE + '/v1/jobs', { method: 'POST', headers: authorizedHeaders, body: csv });
  assert.equal(first.status, 202);
  const firstJob = await first.json();

  const second = await fetch(BASE + '/v1/jobs', { method: 'POST', headers: authorizedHeaders, body: csv });
  assert.equal(second.status, 202);
  const secondJob = await second.json();

  const limited = await fetch(BASE + '/v1/jobs', { method: 'POST', headers: authorizedHeaders, body: csv });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'RATE_LIMIT_EXCEEDED' });

  for (const jobId of [firstJob.jobId, secondJob.jobId]) {
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await fetch(BASE + '/v1/jobs/' + jobId + '/status', {
        headers: { authorization: 'Bearer ' + token },
      });
      assert.equal(status.status, 200);
      state = await status.json();
      if (state.status === 'complete' || state.status === 'failed') break;
      await delay(100);
    }
    assert.equal(state.status, 'complete', JSON.stringify(state));
    const result = await fetch(BASE + '/v1/jobs/' + jobId + '/result', {
      headers: { authorization: 'Bearer ' + token },
    });
    assert.equal(result.status, 200);
  }
});
