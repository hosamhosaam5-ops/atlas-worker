import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/clean-v1/worker.js';

const csv = count => ['name,phone,created_date', ...Array.from({ length: count }, (_, i) => `User ${i + 1},050-123-${String(i + 1).padStart(4, '0')},2025-10-25`)].join('\n');
const request = (method, path, { body, contentType, ip = '192.0.2.10' } = {}) => new Request('https://clean-v1.test' + path, {
  method,
  headers: {
    'cf-connecting-ip': ip,
    ...(contentType ? { 'content-type': contentType } : {}),
  },
  ...(body !== undefined ? { body } : {}),
});

async function previewPost(rowCount, ip) {
  return worker.fetch(request('POST', '/x402/clean_v1/preview', {
    body: csv(rowCount), contentType: 'text/csv; charset=utf-8', ip,
  }));
}

test('health is isolated and does not reference a database or secret binding', async () => {
  const response = await worker.fetch(request('GET', '/health'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'atlas-clean-v1', mode: 'isolated' });
});

test('POST preview returns at most 10 cleaned rows for a 200-row CSV', async () => {
  const response = await previewPost(200, '192.0.2.20');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.preview, true);
  assert.equal(body.preview_rows, 10);
  assert.equal(body.data.length, 10);
  assert.equal(body.source_rows, 200);
  assert.equal(body.truncated, true);
});

test('POST preview supports JSON arrays', async () => {
  const response = await worker.fetch(request('POST', '/x402/clean_v1/preview', {
    body: JSON.stringify([{ 'First Name': '  Ada  ' }, { 'First Name': ' Lin ' }]),
    contentType: 'application/json', ip: '192.0.2.21',
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data, [{ first_name: 'Ada' }, { first_name: 'Lin' }]);
});

test('GET preview reads a small format/data query and returns only first 10 rows', async () => {
  const data = encodeURIComponent(csv(12));
  const response = await worker.fetch(request('GET', '/x402/clean_v1/preview?format=csv&data=' + data, { ip: '192.0.2.22' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 10);
  assert.equal(body.source_rows, 12);
  assert.equal(body.truncated, true);
});

test('preview uses the same 200-row and 100 KiB hard bounds', async () => {
  const tooMany = await previewPost(201, '192.0.2.23');
  assert.equal(tooMany.status, 413);
  assert.deepEqual(await tooMany.json(), { code: 'ROW_LIMIT_EXCEEDED' });

  const tooLarge = await worker.fetch(request('POST', '/x402/clean_v1/preview', {
    body: new Uint8Array(102401), contentType: 'text/csv', ip: '192.0.2.24',
  }));
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), { code: 'FILE_SIZE_LIMIT_EXCEEDED' });
});

test('preview returns stable format, body and query errors without exception details', async () => {
  const wrongFormat = await worker.fetch(request('POST', '/x402/clean_v1/preview', {
    body: 'irrelevant', contentType: 'application/octet-stream', ip: '192.0.2.25',
  }));
  assert.equal(wrongFormat.status, 415);
  assert.deepEqual(await wrongFormat.json(), { code: 'INPUT_FORMAT_UNSUPPORTED' });

  const missing = await worker.fetch(request('GET', '/x402/clean_v1/preview?format=csv', { ip: '192.0.2.26' }));
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { code: 'FILE_BODY_REQUIRED' });
});

test('the free preview has a per-isolate best-effort request rate limit', async () => {
  const ip = '192.0.2.27';
  for (let i = 0; i < 10; i++) {
    const response = await previewPost(1, ip);
    assert.equal(response.status, 200);
  }
  const blocked = await previewPost(1, ip);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { code: 'PREVIEW_RATE_LIMITED' });
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
});

test('paid route remains fail-closed until the separate payment implementation', async () => {
  const response = await worker.fetch(request('POST', '/x402/clean_v1', {
    body: 'name\nAda', contentType: 'text/csv', ip: '192.0.2.28',
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'PAYMENT_ROUTE_NOT_READY' });
});

test('no request file content is written to application logs', async () => {
  const sentinel = 'sensitive-client-content-never-log-8b1d45';
  const captured = [];
  const original = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    original[name] = console[name];
    console[name] = (...args) => captured.push(args.map(String).join(' '));
  }
  try {
    const response = await worker.fetch(request('POST', '/x402/clean_v1/preview', {
      body: `note\n${sentinel}`, contentType: 'text/csv', ip: '192.0.2.29',
    }));
    assert.equal(response.status, 200);
    assert.equal(captured.some(line => line.includes(sentinel)), false);
    const body = await response.json();
    assert.equal(body.data[0].note, sentinel, 'the preview must return the cleaned content to its caller');
  } finally {
    for (const name of Object.keys(original)) console[name] = original[name];
  }
});
