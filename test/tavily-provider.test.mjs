import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  braveSearchRaw,
  classifyBraveError,
  evidenceFromBrave,
  webResearchFromBrave,
} from '../src/ceo/webresearch.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('Tavily provider calls the official search endpoint and normalizes attributed results', async () => {
  let requestUrl;
  let requestInit;
  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(JSON.stringify({
      results: [
        { title: 'Official source', url: 'https://docs.example.test/guide', content: 'A trusted-looking snippet', score: 0.9 },
        { title: 'Duplicate URL', url: 'https://docs.example.test/guide', content: 'duplicate source' },
        { title: 'Invalid URL', url: 'javascript:alert(1)', content: 'must be excluded' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const raw = await braveSearchRaw({ BRAVE: 'TAVILY', TAVILY_API_KEY: 'test-key-do-not-log' }, 'current API docs');
  assert.equal(requestUrl, 'https://api.tavily.com/search');
  assert.equal(requestInit.method, 'POST');
  assert.equal(requestInit.headers['content-type'], 'application/json');
  assert.equal(requestInit.signal instanceof AbortSignal, true);
  const body = JSON.parse(requestInit.body);
  assert.equal(body.api_key, 'test-key-do-not-log');
  assert.equal(body.query, 'current API docs');
  assert.equal(body.search_depth, 'basic');
  assert.equal(body.max_results, 5);
  assert.equal(body.include_answer, false);
  assert.equal(raw.web.results.length, 2);
  assert.equal(raw.web.results[0].description, 'A trusted-looking snippet');
  assert.equal(JSON.stringify(raw).includes('test-key-do-not-log'), false);

  const text = webResearchFromBrave('current API docs', raw);
  assert.match(text, /Official source/);
  assert.match(text, /https:\/\/docs\.example\.test\/guide/);
  assert.equal((text.match(/docs\.example\.test\/guide/g) || []).length, 1);
  const evidence = evidenceFromBrave(raw, 0, 'current API docs');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].verification_level, 'SEARCH_SNIPPET');
  assert.equal(evidence[0].source_url, 'https://docs.example.test/guide');
});

test('Tavily without an API key fails closed and never falls back to mock results', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not fetch without key'); };
  const raw = await braveSearchRaw({ BRAVE: 'TAVILY' }, 'no key query');
  assert.equal(called, false);
  assert.equal(raw.statusCode, 503);
  assert.deepEqual(classifyBraveError(raw), { error_code: 'ERR_UPSTREAM_503', retryable: true });
  assert.match(webResearchFromBrave('no key query', raw), /لا توجد نتائج بحث/);
});

test('Tavily HTTP auth/rate-limit failures are surfaced as provider failures', async (t) => {
  for (const status of [401, 403, 429]) {
    await t.test('HTTP ' + status, async () => {
      globalThis.fetch = async () => new Response('provider detail must not be forwarded', { status });
      const raw = await braveSearchRaw({ BRAVE: 'TAVILY', TAVILY_API_KEY: 'test-key' }, 'test');
      assert.equal(raw.statusCode, status);
      const classified = classifyBraveError(raw);
      if (status === 401 || status === 403) assert.equal(classified.error_code, 'ERR_UNAUTHORIZED_TOOL');
      else assert.equal(classified.error_code, 'ERR_RATE_LIMIT');
      assert.equal(JSON.stringify(raw).includes('provider detail'), false);
    });
  }
});

test('Tavily malformed successful response becomes an explicit upstream error', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ unexpected: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const raw = await braveSearchRaw({ BRAVE: 'TAVILY', TAVILY_API_KEY: 'test-key' }, 'malformed');
  assert.equal(raw.statusCode, 502);
  assert.equal(classifyBraveError(raw).error_code, 'ERR_UPSTREAM_502');
  assert.match(webResearchFromBrave('malformed', raw), /لا توجد نتائج بحث/);
});

test('Tavily network timeouts are normalized without exposing credentials', async () => {
  globalThis.fetch = async () => { throw new Error('operation timeout with key=test-key'); };
  const raw = await braveSearchRaw({ BRAVE: 'TAVILY', TAVILY_API_KEY: 'test-key' }, 'timeout query');
  assert.equal(raw.statusCode, 0);
  assert.equal(JSON.stringify(raw).includes('test-key'), false);
  assert.equal(classifyBraveError(raw).error_code, 'ERR_TIMEOUT');
});
