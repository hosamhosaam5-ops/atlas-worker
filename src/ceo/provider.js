// AI PROVIDER ADAPTER — free-first ROUTER over Workers AI, with optional OpenRouter fallback.
// CEO Core never talks to OpenRouter directly; swapping providers changes only this file.
// Each route has its own bounded timeout so a slow primary cannot consume the entire
// request deadline before the fallback gets a chance. Provider failure MUST NOT mutate
// state or fabricate a reply — the caller treats any terminal failure as AI_FAILED.

export const AI_TIMEOUT_MS = 60000;
export const AI_ROUTE_TIMEOUT_MS = 20000;
export const AI_FALLBACK_TIMEOUT_MS = 35000;

function makeError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function withRouteTimeout(provider, args, timeoutMs, parentSignal) {
  const ctrl = new AbortController();
  let timer;
  const abortFromParent = () => ctrl.abort();
  if (parentSignal) {
    if (parentSignal.aborted) ctrl.abort();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(makeError(provider.name + ' route timeout after ' + timeoutMs + 'ms', 'AI_TIMEOUT'));
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(() => provider.chat({ ...args, signal: ctrl.signal })),
    timeout,
  ]).finally(() => {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
  });
}

export function makeMockProvider(scenario) {
  // scenario set via AI_MOCK_SCENARIO (test seam) — default: echo-style honest reply.
  return {
    name: 'mock',
    async chat({ system, user, phase }) {
      const sc = scenario || 'default';
      if (sc === 'fail') {
        const e = new Error('mock provider failure (simulated)');
        e.code = 'AI_PROVIDER_ERROR';
        throw e;
      }
      if (sc === 'timeout') {
        await new Promise(r => setTimeout(r, AI_TIMEOUT_MS * 10)); // will be aborted
      }
      if (sc === 'malformed') {
        return { content: 'هذا ليس JSON على الإطلاق — نص حر بدون envelope' };
      }
      if (sc === 'web') {
        return { content: JSON.stringify({ reply: 'سأبحث في الويب.', actions: [{ tool: 'web_research', input: { query: 'data cleaning freelance market' } }], memories: [] }) };
      }
      if (sc === 'calc') {
        return { content: JSON.stringify({ reply: 'سأحسب ذلك بالحاسبة.', actions: [{ tool: 'calculator', input: { expression: '125*0.15' } }], memories: [] }) };
      }
      if (sc === 'blocked') {
        return { content: JSON.stringify({ reply: 'BLOCKED: هذا الإجراء يحتاج موافقة المؤسس الصريحة قبل التنفيذ.', actions: [], memories: [] }) };
      }
      if (sc === 'goal') {
        return { content: JSON.stringify({ reply: 'تم تسجيل الهدف.', actions: [], memories: [{ category: 'goal', content: 'هدف المشروع هو اختبار النظام' }] }) };
      }
      if (phase === 'final') {
        return { content: JSON.stringify({ reply: 'إجابة نهائية (mock): ' + String(user).slice(0, 120), memories: [] }) };
      }
      // default: no-tool Arabic reply envelope
      return { content: JSON.stringify({ reply: 'تم استلام رسالتك (mock): ' + String(user).slice(0, 120), actions: [], memories: [] }) };
    }
  };
}

export function getProvider(env) {
  const kind = String(env.AI_PROVIDER || 'MOCK').toUpperCase();
  if (kind === 'MOCK') return makeMockProvider(env.AI_MOCK_SCENARIO);
  if (kind === 'WORKERS_AI') {
    const providerTimeoutMs = Math.max(10, Number(env.AI_PROVIDER_TIMEOUT_MS || AI_TIMEOUT_MS));
    return {
      name: 'workers-ai',
      async chat({ model, system, user, signal }) {
        if (!env.AI || typeof env.AI.run !== 'function') {
          const e = new Error('Workers AI binding AI is not configured');
          e.code = 'AI_PROVIDER_ERROR';
          throw e;
        }
        const ctrl = new AbortController();
        const abortFromParent = () => ctrl.abort();
        if (signal) {
          if (signal.aborted) ctrl.abort();
          else signal.addEventListener('abort', abortFromParent, { once: true });
        }
        const timer = setTimeout(() => ctrl.abort(), providerTimeoutMs);
        try {
          const result = await env.AI.run(
            model || env.AI_MODEL || '@cf/zai-org/glm-4.7-flash',
            {
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              temperature: 0.2,
            },
            { rejectIfBusy: true, signal: ctrl.signal },
          );
          const content =
            result?.response ??
            result?.choices?.[0]?.message?.content ??
            result?.result?.response ??
            '';
          if (typeof content !== 'string' || !content.trim()) {
            const e = new Error('Workers AI returned empty/malformed response');
            e.code = 'AI_PROVIDER_ERROR';
            throw e;
          }
          return { content };
        } catch (e) {
          if (e?.name === 'AbortError' || ctrl.signal.aborted) {
            const x = new Error('Workers AI request timeout');
            x.code = 'AI_TIMEOUT';
            throw x;
          }
          if (e?.status === 429 || e?.code === 3040) {
            const x = new Error('Workers AI capacity/rate limit');
            x.code = 'AI_RATE_LIMIT';
            throw x;
          }
          throw e;
        } finally {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', abortFromParent);
        }
      },
    };
  }
  if (kind === 'ROUTER') {
    const providers = [];
    const routeTimeoutMs = Math.max(10, Math.min(AI_TIMEOUT_MS - 1000, Number(env.AI_ROUTE_TIMEOUT_MS || AI_ROUTE_TIMEOUT_MS)));
    const fallbackTimeoutMs = Math.max(10, Math.min(AI_TIMEOUT_MS - routeTimeoutMs - 1000, Number(env.AI_FALLBACK_TIMEOUT_MS || AI_FALLBACK_TIMEOUT_MS)));
    if (env.AI && typeof env.AI.run === 'function') {
      providers.push({
        name: 'workers-ai',
        chat: getProvider({
          ...env,
          AI_PROVIDER: 'WORKERS_AI',
          AI_PROVIDER_TIMEOUT_MS: String(routeTimeoutMs),
        }).chat,
        timeoutMs: routeTimeoutMs,
      });
    }
    if (env.OPENROUTER_API_KEY) {
      providers.push({
        name: 'openrouter',
        chat: getProvider({
          ...env,
          AI_PROVIDER: 'OPENROUTER',
          OPENROUTER_TIMEOUT_MS: String(fallbackTimeoutMs),
        }).chat,
        timeoutMs: fallbackTimeoutMs,
      });
    }
    if (!providers.length) {
      const e = new Error('No free-first LLM provider is configured');
      e.code = 'AI_PROVIDER_UNAVAILABLE';
      throw e;
    }
    let last;
    return {
      name: 'router',
      async chat({ model, system, user, signal }) {
        for (const p of providers) {
          try {
            // Provider identifiers are not interchangeable: Workers AI receives AI_MODEL,
            // while OpenRouter must receive its own model slug (free-first by default).
            const routeModel = p.name === 'openrouter'
              ? (env.OPENROUTER_FREE_MODEL || 'openrouter/free')
              : model;
            return await withRouteTimeout(
              p,
              { model: routeModel, system, user },
              p.timeoutMs,
              signal,
            );
          } catch (e) {
            last = e;
            if (e?.code !== 'AI_RATE_LIMIT' && e?.code !== 'AI_PROVIDER_ERROR' && e?.code !== 'AI_TIMEOUT') throw e;
          }
        }
        const e = new Error('All configured LLM routes failed: ' + String(last?.message || last || 'unknown'));
        e.code = last?.code || 'AI_PROVIDER_ERROR';
        throw e;
      },
    };
  }
  if (kind === 'OPENROUTER') {
    return {
      name: 'openrouter',
      async chat({ model, system, user, signal }) {
        const key = env.OPENROUTER_API_KEY;
        if (!key) { const e = new Error('OPENROUTER_API_KEY not set'); e.code = 'AI_PROVIDER_ERROR'; throw e; }
        const timeoutMs = Math.max(10, Number(env.OPENROUTER_TIMEOUT_MS || AI_TIMEOUT_MS));
        const ctrl = new AbortController();
        const abortFromParent = () => ctrl.abort();
        if (signal) {
          if (signal.aborted) ctrl.abort();
          else signal.addEventListener('abort', abortFromParent, { once: true });
        }
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({ model: model || env.OPENROUTER_FREE_MODEL || 'openrouter/free', messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
            signal: ctrl.signal,
          });
          if (!res.ok) { const e = new Error('openrouter http ' + res.status); e.code = res.status === 429 ? 'AI_RATE_LIMIT' : 'AI_PROVIDER_ERROR'; throw e; }
          const data = await res.json();
          const content = data?.choices?.[0]?.message?.content;
          if (typeof content !== 'string' || !content.trim()) { const e = new Error('OpenRouter returned empty/malformed response'); e.code = 'AI_PROVIDER_ERROR'; throw e; }
          return { content };
        } catch (e) {
          if (e?.name === 'AbortError' || ctrl.signal.aborted) {
            const x = new Error('OpenRouter request timeout');
            x.code = 'AI_TIMEOUT';
            throw x;
          }
          throw e;
        } finally {
          clearTimeout(t);
          if (signal) signal.removeEventListener('abort', abortFromParent);
        }
      }
    };
  }
  const e = new Error('unknown AI_PROVIDER: ' + kind);
  e.code = 'AI_PROVIDER_ERROR';
  throw e;
}

// Call with timeout — wraps any provider and propagates cancellation to abortable adapters.
export async function chatWithTimeout(provider, args, timeoutMs = AI_TIMEOUT_MS) {
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(makeError('AI provider timeout after ' + timeoutMs + 'ms', 'AI_TIMEOUT'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      provider.chat({ ...args, signal: ctrl.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
