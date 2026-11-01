import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../src/data-cleaning/worker.js';

test('TEST_MODE is absent from the production Wrangler configuration', async () => {
  const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /^\\s*TEST_MODE\\s*=/m);
});

test('test-only routes are closed when TEST_MODE is unset', async () => {
  const response = await worker.fetch(new Request('https://worker/__test/health'), {});
  assert.equal(response.status, 404);
});

test('public upload fails closed when the API secret is not configured', async () => {
  const response = await worker.fetch(new Request('https://worker/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'text/csv' },
    body: 'name\\nSynthetic\\n',
  }), {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'AUTH_NOT_CONFIGURED' });
});

test('public upload rejects an invalid bearer token before reading or queuing input', async () => {
  const response = await worker.fetch(new Request('https://worker/v1/jobs', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + 'x'.repeat(48),
      'content-type': 'text/csv',
      'x-atlas-cleaning-options': JSON.stringify({ inputFormat: 'csv', operations: [] }),
    },
    body: 'name\\nSynthetic\\n',
  }), { CLEANING_API_TOKEN: 'expected-test-token-not-for-production-0000000000' });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'UNAUTHORIZED' });
});
