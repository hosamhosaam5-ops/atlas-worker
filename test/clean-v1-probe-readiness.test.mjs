import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForCleanV1PreviewRoute } from '../ops/scripts/clean-v1-trial-probe.mjs';

test('readiness stops and emits bounded response diagnostics on the first unexpected non-404 status', async () => {
  let requests = 0;
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.map(String).join(' '));
  try {
    await assert.rejects(
      waitForCleanV1PreviewRoute('https://trial.example.workers.dev', {
        fetchImpl: async (url, init) => {
          requests += 1;
          assert.equal(url, 'https://trial.example.workers.dev/x402/clean_v1/preview');
          assert.equal(init.method, 'GET');
          return new Response('upstream diagnostic body', {
            status: 503,
            headers: {
              'cf-ray': 'test-ray-123',
              'content-type': 'text/plain; charset=utf-8',
            },
          });
        },
      }),
      error => error.code === 'PREVIEW_ROUTE_READINESS_UNEXPECTED_RESPONSE',
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(requests, 1, 'unexpected non-404 response must stop polling immediately');
  assert.ok(output.some(line => line.includes('status=503')));
  assert.ok(output.some(line => line.includes('cf-ray=test-ray-123')));
  assert.ok(output.some(line => line.includes('content-type=text/plain; charset=utf-8')));
  assert.ok(output.some(line => line.includes('body-sanitized-2kb=upstream diagnostic body')));
});
