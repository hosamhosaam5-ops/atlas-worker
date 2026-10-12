// WEB RESEARCH PROVIDER ADAPTER — BRAVE=MOCK default, zero quota, zero network.
// Ports the backup's Brave-result handling (Split Web Research Queries → Brave Search
// → Action Executor web_research IMPL + classifyToolError + evidence extraction).
// Anti-fabrication: a provider failure/timeout/malformed response yields an explicit
// error record — NEVER invented search results.

export function cleanSnippet(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, String.fromCharCode(39)).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

export function getBraveProvider(env) {
  const mode = (env.BRAVE || 'MOCK').toUpperCase();
  if (mode === 'MOCK') {
    const scenario = env.BRAVE_MOCK_SCENARIO || 'ok';
    return {
      async search(query) {
        if (scenario === 'empty') return { web: { results: [] } };
        if (scenario === 'fail') return { error: { statusCode: 500, message: 'MOCK internal error' }, statusCode: 500 };
        if (scenario === 'rate_limit') return { error: { statusCode: 429, message: 'MOCK rate limit' }, statusCode: 429 };
        if (scenario === 'malformed') return { unexpected: true };
        if (scenario === 'timeout') { const e = new Error('MOCK brave timeout'); e.code = 'BRAVE_TIMEOUT'; throw e; }
        return {
          web: {
            results: [
              { title: 'MOCK result 1 for ' + query, url: 'https://example.com/1', description: 'MOCK snippet one — not real data.' },
              { title: 'MOCK result 2 for ' + query, url: 'https://example.org/2', description: 'MOCK snippet two — not real data.' },
              { title: 'MOCK result 1 duplicate URL', url: 'https://example.com/1', description: 'dupe' },
            ]
          }
        };
      }
    };
  }

  // Tavily is selected explicitly with BRAVE="TAVILY". It uses the existing
  // web_research action contract, so results remain source-attributed and deduped.
  // Never fall back to mock results when a live key is missing or the API fails.
  if (mode === 'TAVILY') {
    return {
      async search(query) {
        const apiKey = String(env.TAVILY_API_KEY || '').trim();
        if (!apiKey) {
          return { error: { statusCode: 503, message: 'TAVILY_API_KEY not configured' }, statusCode: 503 };
        }
        let response;
        try {
          response = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              api_key: apiKey,
              query: String(query || '').slice(0, 1000),
              search_depth: 'basic',
              topic: 'general',
              max_results: 5,
              include_answer: false,
              include_raw_content: false,
              include_images: false,
            }),
            signal: AbortSignal.timeout(10000),
          });
        } catch (e) {
          const message = String(e && e.message || e || 'Tavily network error');
          return { error: { statusCode: 0, message: /timeout|abort/i.test(message) ? 'Tavily search timeout' : 'Tavily network error' }, statusCode: 0 };
        }
        if (!response.ok) {
          // Do not echo the response body: it may contain provider-specific information.
          return { error: { statusCode: response.status, message: 'Tavily HTTP ' + response.status }, statusCode: response.status };
        }
        let payload;
        try {
          payload = await response.json();
        } catch {
          return { error: { statusCode: 502, message: 'Tavily returned invalid JSON' }, statusCode: 502 };
        }
        if (!payload || !Array.isArray(payload.results)) {
          return { error: { statusCode: 502, message: 'Tavily response did not contain a results array' }, statusCode: 502 };
        }
        const results = payload.results.slice(0, 5).map((r) => ({
          title: String(r && r.title || ''),
          url: String(r && r.url || ''),
          description: String(r && (r.content || r.snippet || r.description) || '').slice(0, 1000),
        })).filter((r) => {
          try { const u = new URL(r.url); return (u.protocol === 'https:' || u.protocol === 'http:') && Boolean(r.title || r.description); }
          catch { return false; }
        });
        return { web: { results }, statusCode: response.status };
      }
    };
  }

  // Legacy Brave path remains available when explicitly configured.
  return {
    async search(query) {
      const apiKey = String(env.BRAVE_API_KEY || '').trim();
      if (!apiKey) return { error: { statusCode: 503, message: 'BRAVE_API_KEY not configured' }, statusCode: 503 };
      try {
        const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=5', {
          headers: { 'X-Subscription-Token': apiKey, accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return { error: { statusCode: res.status, message: 'Brave HTTP ' + res.status }, statusCode: res.status };
        return await res.json();
      } catch (e) {
        const message = String(e && e.message || e || 'Brave network error');
        return { error: { statusCode: 0, message: /timeout|abort/i.test(message) ? 'Brave search timeout' : 'Brave network error' }, statusCode: 0 };
      }
    }
  };
}

// Searches one query and returns a Brave-shaped raw item (or {error/statusCode} on failure).
// Throws only on timeout-class errors (caught upstream as ERR_TIMEOUT).
export async function braveSearchRaw(env, query) {
  const provider = getBraveProvider(env);
  const raw = await provider.search(String(query || ''));
  // Anti-fabrication normalization: provider error payloads (incl. n8n-style
  // continueRegularOutput error items) are NOT search results. Normalize any object
  // carrying an `error` field (without a results payload) to an empty-result shape so
  // webResearchFromBrave yields the explicit error text and classifyBraveError
  // classifies the real HTTP code. Results are never invented.
  if (raw && typeof raw === 'object' && raw.error && !raw.web && !raw.results) {
    return { web: { results: [] }, error: raw.error, statusCode: raw.statusCode || (raw.error && (raw.error.statusCode || raw.error.status)) || 0 };
  }
  return raw;
}

// Ported verbatim from backup Action Executor's web_research IMPL.
export function webResearchFromBrave(q, brave) {
  q = String(q || '');
  const results = brave ? ((brave.web && brave.web.results) ? brave.web.results : (brave.results || [])) : [];
  const seenUrls = new Set();
  const items = [];
  for (const r of results) {
    const url = String(r.url || '');
    if (url && seenUrls.has(url)) continue;
    if (url) seenUrls.add(url);
    items.push('- ' + cleanSnippet(r.title) + ' | ' + url + (r.description ? ': ' + cleanSnippet(r.description).slice(0, 150) : ''));
    if (items.length >= 5) break;
  }
  return items.length
    ? 'نتائج البحث عن "' + q + '":' + String.fromCharCode(10) + items.join(String.fromCharCode(10))
    : 'خطأ: لا توجد نتائج بحث عن: ' + q;
}

// Ported verbatim from backup classifyToolError (braveRaw branch).
export function classifyBraveError(braveRaw) {
  if (braveRaw && typeof braveRaw === 'object') {
    const code = Number(braveRaw.statusCode || (braveRaw.error && (braveRaw.error.statusCode || braveRaw.error.status)) || 0);
    if (code === 429) return { error_code: 'ERR_RATE_LIMIT', retryable: true };
    if (code === 502) return { error_code: 'ERR_UPSTREAM_502', retryable: true };
    if (code === 503) return { error_code: 'ERR_UPSTREAM_503', retryable: true };
    if (code === 401 || code === 403) return { error_code: 'ERR_UNAUTHORIZED_TOOL', retryable: false };
    if (code === 404) return { error_code: 'ERR_NOT_FOUND', retryable: false };
    if (code >= 400 && code < 500) return { error_code: 'ERR_INVALID_INPUT', retryable: false };
    if (code >= 500) return { error_code: 'ERR_INTERNAL', retryable: true };
    const em = String((braveRaw.error && (braveRaw.error.message || braveRaw.error.description)) || '').toLowerCase();
    if (em.includes('timeout') || em.includes('etimedout')) return { error_code: 'ERR_TIMEOUT', retryable: true };
  }
  return null;
}

// Ported from backup evidence extraction (web_research branch).
export function evidenceFromBrave(brave, wi, query) {
  const bresults = brave ? ((brave.web && brave.web.results) ? brave.web.results : (brave.results || [])) : [];
  const seenU = new Set();
  const out = [];
  for (const br of bresults.slice(0, 5)) {
    const url = String(br.url || '');
    if (url && seenU.has(url)) continue;
    if (url) seenU.add(url);
    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { domain = ''; }
    out.push({
      claim: String(br.title || '') + (br.description ? ': ' + cleanSnippet(br.description).slice(0, 150) : ''),
      class: 'ATTRIBUTED_CLAIM',
      verification_level: 'SEARCH_SNIPPET',
      source_url: url || null,
      source_title: cleanSnippet(br.title) || null,
      source_domain: domain || null,
      query: query || null,
      web_index: wi,
      evidence_excerpt: cleanSnippet(br.description).slice(0, 200) || null,
      confidence: 'LOWER_CONFIDENCE',
      evidence_limit: 'مقتطف من نتيجة بحث — يعكس ما يذكره المصدر وليس تدقيقًا مستقلًا لصحته'
    });
  }
  return out;
}
