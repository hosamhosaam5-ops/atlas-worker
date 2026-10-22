import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultAdapters } from '../src/crons/revenueWatch.js';

test('revenue watch defaults every external provider to MOCK without network calls', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network call'); };
  try {
    assert.deepEqual(await defaultAdapters.checkAgentSouk({}), { data: [] });
    assert.deepEqual(await defaultAdapters.checkDatapoint({}), {});
    assert.deepEqual(await defaultAdapters.checkBountyBook({}), {});
    assert.equal(calls, 0, 'MOCK must not call external providers');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('revenue watch makes provider requests only when each provider is explicitly LIVE', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('agentsouk')) return new Response(JSON.stringify({ object: 'list', data: [], has_more: false, next_cursor: null }), { status: 200 });
    if (String(url).includes('datapoint')) return new Response(JSON.stringify({ sales_count: 0 }), { status: 200 });
    if (String(url).includes('bountybook')) return new Response(JSON.stringify({ completed: 42 }), { status: 200 });
    throw new Error('unexpected URL: ' + url);
  };
  try {
    const env = {
      AGENT_SOUK_PROVIDER: 'LIVE',
      DATAPOINT_PROVIDER: 'LIVE',
      BOUNTYBOOK_PROVIDER: 'LIVE',
    };
    await Promise.all([
      defaultAdapters.checkAgentSouk(env),
      defaultAdapters.checkDatapoint(env),
      defaultAdapters.checkBountyBook(env),
    ]);
    assert.equal(urls.length, 3);
    assert.ok(urls.includes('https://api.agentsouk.dev/v1/bounties?limit=100&first_party=false'),
      'AgentSouk request must exclude platform-owned bounties and use the maximum supported page size');
    assert.ok(urls.some(url => url.includes('api.datapoint.market')));
    assert.ok(urls.some(url => url.includes('api.bountybook.ai')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('revenue watch rejects unknown provider modes instead of silently making requests', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network call'); };
  try {
    await assert.rejects(
      defaultAdapters.checkDatapoint({ DATAPOINT_PROVIDER: 'AUTO' }),
      error => error && error.code === 'INVALID_PROVIDER_MODE'
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LIVE provider HTTP errors are surfaced instead of treated as empty data', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  try {
    await assert.rejects(
      defaultAdapters.checkDatapoint({ DATAPOINT_PROVIDER: 'LIVE' }),
      error => error && error.code === 'PROVIDER_HTTP_ERROR' && error.message === 'PROVIDER_HTTP_503'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
