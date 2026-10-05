// AI PROVIDER ADAPTER — free-first ROUTER over Workers AI, with optional OpenRouter fallback.
// CEO Core never talks to OpenRouter directly; swapping providers changes only this file.
// Timeout enforced with AbortController so a hung provider becomes an explicit failure,
// never a silent hang. Provider failure MUST NOT mutate state or fabricate a reply —
// the caller (pipeline) treats any throw as AI_FAILED and routes to an honest error reply.

export const AI_TIMEOUT_MS = 60000;

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
    return {
      name: 'workers-ai',
      async chat({ model, system, user }) {
        if (!env.AI || typeof env.AI.run !== 'function') {
          const e = new Error('Workers AI binding AI is not configured');
          e.code = 'AI_PROVIDER_ERROR';
          throw e;
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
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
            { rejectIfBusy: true },
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
        }
      },
    };
  }
  if (kind === 'ROUTER') {
    const providers = [];
    if (env.AI && typeof env.AI.run === 'function') {
      providers.push({ name: 'workers-ai', chat: getProvider({ ...env, AI_PROVIDER: 'WORKERS_AI' }).chat });
    }
    if (env.OPENROUTER_API_KEY) {
      providers.push({ name: 'openrouter', chat: getProvider({ ...env, AI_PROVIDER: 'OPENROUTER' }).chat });
    }
    if (!providers.length) {
      const e = new Error('No free-first LLM provider is configured');
      e.code = 'AI_PROVIDER_UNAVAILABLE';
      throw e;
    }
    let last;
    return { name: 'router', async chat({ model, system, user }) {
      for (const p of providers) {
      try {
        return await p.chat({ model, system, user });
      } catch (e) {
        last = e;
        if (e?.code !== 'AI_RATE_LIMIT' && e?.code !== 'AI_PROVIDER_ERROR' && e?.code !== 'AI_TIMEOUT') throw e;
      }
      }
      const e = new Error('All configured LLM routes failed: ' + String(last?.message || last || 'unknown'));
    e.code = last?.code || 'AI_PROVIDER_ERROR';
      throw e;
    }};
  }
  if (kind === 'OPENROUTER') {
    // Not used in M2. Implemented structurally only — real use requires OPENROUTER_API_KEY
    // secret set by the founder, and explicit approval. Zero quota consumed in M2.
    return {
      name: 'openrouter',
      async chat({ model, system, user }) {
        const key = env.OPENROUTER_API_KEY;
        if (!key) { const e = new Error('OPENROUTER_API_KEY not set'); e.code = 'AI_PROVIDER_ERROR'; throw e; }
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
        try {
          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
            signal: ctrl.signal,
          });
          if (!res.ok) { const e = new Error('openrouter http ' + res.status); e.code = res.status === 429 ? 'AI_RATE_LIMIT' : 'AI_PROVIDER_ERROR'; throw e; }
          const data = await res.json();
          return { content: data?.choices?.[0]?.message?.content || '' };
        } finally { clearTimeout(t); }
      }
    };
  }
  const e = new Error('unknown AI_PROVIDER: ' + kind);
  e.code = 'AI_PROVIDER_ERROR';
  throw e;
}

// Call with timeout — wraps any provider.
export async function chatWithTimeout(provider, args, timeoutMs = AI_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await Promise.race([
      provider.chat(args),
      new Promise((_, rej) => ctrl.signal.addEventListener('abort', () => {
        const e = new Error('AI provider timeout after ' + timeoutMs + 'ms');
        e.code = 'AI_TIMEOUT';
        rej(e);
      })),
    ]);
  } finally { clearTimeout(timer); }
}
