import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, AI_ROUTE_TIMEOUT_MS, AI_FALLBACK_TIMEOUT_MS, AI_TIMEOUT_MS } from '../src/ceo/provider.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function abortableNever(options = {}) {
  return new Promise((_, reject) => {
    if (options.signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
      return;
    }
    options.signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    }, { once: true });
  });
}

test('ROUTER falls back from a timed-out Workers AI route and uses OpenRouter model slug', async () => {
  let aiCalls = 0;
  let requestBody;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'fallback-ok' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const provider = getProvider({
    AI_PROVIDER: 'ROUTER',
    AI_MODEL: '@cf/zai-org/glm-4.7-flash',
    AI_ROUTE_TIMEOUT_MS: '15',
    AI_FALLBACK_TIMEOUT_MS: '1000',
    OPENROUTER_API_KEY: 'test-key-not-real',
    AI: {
      run: async (_model, _input, options) => {
        aiCalls += 1;
        return abortableNever(options);
      },
    },
  });

  const result = await provider.chat({
    model: '@cf/zai-org/glm-4.7-flash',
    system: 'system prompt',
    user: 'test request',
  });

  assert.equal(aiCalls, 1);
  assert.equal(result.content, 'fallback-ok');
  assert.equal(requestBody.model, 'openrouter/free');
  assert.deepEqual(requestBody.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'test request' },
  ]);
});

test('ROUTER keeps the primary Workers AI route when it succeeds', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('OpenRouter should not be called after primary success');
  };

  const provider = getProvider({
    AI_PROVIDER: 'ROUTER',
    AI_MODEL: '@cf/zai-org/glm-4.7-flash',
    OPENROUTER_API_KEY: 'test-key-not-real',
    AI: {
      run: async model => {
        assert.equal(model, '@cf/zai-org/glm-4.7-flash');
        return { response: 'primary-ok' };
      },
    },
  });

  const result = await provider.chat({
    model: '@cf/zai-org/glm-4.7-flash',
    system: 'system prompt',
    user: 'test request',
  });

  assert.equal(result.content, 'primary-ok');
  assert.equal(fetchCalls, 0);
});

test('ROUTER returns a classified timeout when the only configured route stalls', async () => {
  const provider = getProvider({
    AI_PROVIDER: 'ROUTER',
    AI_ROUTE_TIMEOUT_MS: '15',
    AI: {
      run: async (_model, _input, options) => abortableNever(options),
    },
  });

  await assert.rejects(
    provider.chat({
      model: '@cf/zai-org/glm-4.7-flash',
      system: 'system prompt',
      user: 'test request',
    }),
    error => error?.code === 'AI_TIMEOUT',
  );
});


test('Workers AI disables unbounded reasoning and caps generated output', async () => {
  let capturedInput;
  const provider = getProvider({
    AI_PROVIDER: 'WORKERS_AI',
    AI_MODEL: '@cf/zai-org/glm-4.7-flash',
    AI: {
      run: async (_model, input) => {
        capturedInput = input;
        return { response: '{"reply":"ok","actions":[],"memories":[]}' };
      },
    },
  });

  const result = await provider.chat({
    model: '@cf/zai-org/glm-4.7-flash',
    system: 'system prompt',
    user: 'test request',
  });

  assert.equal(result.content, '{"reply":"ok","actions":[],"memories":[]}');
  assert.equal(capturedInput.chat_template_kwargs.enable_thinking, false);
  assert.equal(capturedInput.chat_template_kwargs.clear_thinking, true);
  assert.equal(capturedInput.max_completion_tokens, 1536);
});


test('default route time budgets give primary latency while staying inside the global deadline', () => {
  assert.equal(AI_TIMEOUT_MS, 60000);
  assert.equal(AI_ROUTE_TIMEOUT_MS, 45000);
  assert.equal(AI_FALLBACK_TIMEOUT_MS, 14000);
  assert.ok(AI_ROUTE_TIMEOUT_MS + AI_FALLBACK_TIMEOUT_MS < AI_TIMEOUT_MS);
});
