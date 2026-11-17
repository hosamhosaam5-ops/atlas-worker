import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runCleanV1TrialProbe,
  sanitizeBody,
} from '../ops/scripts/clean-v1-trial-probe.mjs';

test('unexpected preview response diagnostics retain the already-read response body', async () => {
  let requests = 0;
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.map(String).join(' '));

  try {
    await assert.rejects(
      runCleanV1TrialProbe('https://trial.example.workers.dev', {
        fetchImpl: async (url, init) => {
          requests += 1;
          if (requests === 1) {
            assert.equal(url, 'https://trial.example.workers.dev/x402/clean_v1/preview');
            assert.equal(init.method, 'GET');
            return new Response('', { status: 415 });
          }
          assert.equal(url, 'https://trial.example.workers.dev/x402/clean_v1/preview');
          assert.equal(init.method, 'POST');
          assert.equal(init.headers['content-type'], 'text/csv');
          assert.equal(init.body.split('\n').length, 11);
          return new Response('preview route not ready yet', {
            status: 503,
            headers: {
              'cf-ray': 'trial-diagnostic-ray',
              'content-type': 'text/plain; charset=utf-8',
            },
          });
        },
      }),
      /PREVIEW_10_ROWS_CONTRACT_FAILED/,
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(requests, 2, 'the failed 10-row upload is not retried');
  assert.ok(output.some(line => line.includes('PREVIEW_10_ROWS_FAILED | status=503')));
  assert.ok(output.some(line => line.includes('cf-ray=trial-diagnostic-ray')));
  assert.ok(output.some(line => line.includes('content-type=text/plain; charset=utf-8')));
  assert.ok(output.some(line => line.includes('body-sanitized-2kb=preview route not ready yet')));
});

test('response diagnostic bodies are sanitized and bounded to 2 KiB in UTF-8 bytes', () => {
  const raw = 'é'.repeat(2_000) + 'Bearer do-not-print-this-token';
  const safe = sanitizeBody(raw);
  assert.ok(Buffer.byteLength(safe, 'utf8') <= 2 * 1024);
  assert.ok(!safe.includes('do-not-print-this-token'));
});
