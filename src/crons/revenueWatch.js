// SMART REVENUE WATCH — ported from backup workflow "ATLAS — Smart Revenue Watch (read-only)" (XHS3xCpLGfPUm3G6).
// Provider calls are fail-closed: every external source defaults to MOCK and requires an explicit LIVE setting.
// Same event logic: read providers → detect demand events → upsert watch state → alert only on real events.
// Idempotent: events are keyed by stable provider item IDs, not aggregate counts.

function providerMode(env, key) {
  const mode = String(env?.[key] ?? 'MOCK').trim().toUpperCase();
  if (mode !== 'MOCK' && mode !== 'LIVE') {
    throw Object.assign(new Error('INVALID_PROVIDER_MODE_' + key), { code: 'INVALID_PROVIDER_MODE' });
  }
  return mode;
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    throw Object.assign(new Error('PROVIDER_HTTP_' + response.status), { code: 'PROVIDER_HTTP_ERROR' });
  }
  return response.json();
}

// ---- Detect Demand Events ----
export function detectDemandEvents({ souk, dp, bb, state }) {
  const seen = new Set();
  const alertedPrefix = 'watch|alerted|';
  for (const row of state || []) {
    const key = row && row.idempotency_key;
    if (typeof key !== 'string' || !key) continue;
    seen.add(key);
    // Alert rows are persisted with an outer "watch|alerted|" prefix.
    // Normalize them so event generation and delivery idempotency share one key.
    if (key.startsWith(alertedPrefix)) seen.add(key.slice(alertedPrefix.length));
  }

  const events = [];
  function emit(kind, key, detail) {
    if (!seen.has(key)) events.push({ alert_key: key, event_kind: kind, detail, detected_at: new Date().toISOString() });
  }

  const soukJobs = Array.isArray(souk && souk.data) ? souk.data : (Array.isArray(souk) ? souk : []);
  for (const job of soukJobs) {
    if (!job || typeof job !== 'object') continue;
    const id = String(job.id ?? '').trim();
    // AgentSouk's public schema includes buyer.first_party. Fail closed if the
    // buyer's third-party status is missing or indicates platform-owned demand.
    if (!id || !job.buyer || job.buyer.first_party !== false) continue;
    const title = String(job.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const budget = String(job.budget_display ?? '').replace(/\s+/g, ' ').trim().slice(0, 64);
    const detail = 'AgentSouk live open bounty ' + id
      + (title ? ': ' + title : '')
      + (budget ? ' (' + budget + ')' : '');
    emit('BUYER_REQUEST_FOUND', 'watch|souk|' + encodeURIComponent(id), detail);
  }

  const sales = (dp && (dp.sales_count || dp.purchases || dp.orders)) || 0;
  if (sales > 0) {
    emit('ORDER_RECEIVED', 'watch|dp|' + sales, 'datapoint DE-LU sales signal: ' + sales);
  }

  const completed = bb && bb.completed;
  const lastCompleted = (state || []).filter(r => r.idempotency_key === 'watch|bb|completed').map(r => Number(r.progress || 0))[0] || 0;
  if (typeof completed === 'number' && completed > lastCompleted && lastCompleted > 0) {
    emit('PLATFORM_RECOVERY', 'watch|bb|recovered|' + completed, 'BountyBook completed count rose: ' + lastCompleted + ' -> ' + completed);
  }

  const out = [];
  for (const e of events) out.push({ ...e, item_type: 'event' });
  if (typeof completed === 'number') {
    out.push({ item_type: 'marker', idempotency_key: 'watch|bb|completed', progress: completed, payload_json: JSON.stringify({ completed }), updated_at: new Date().toISOString(), created_at: new Date().toISOString() });
  }
  return out;
}

// Default adapters honor provider configuration. MOCK makes no network request.
// LIVE must be explicitly enabled per provider in Worker vars.
export const defaultAdapters = {
  async checkAgentSouk(env) {
    if (providerMode(env, 'AGENT_SOUK_PROVIDER') === 'MOCK') return { data: [] };
    // Public API defaults to open, unexpired bounties. Exclude platform-owned
    // first-party items server-side and request the largest supported page.
    return fetchJson('https://api.agentsouk.dev/v1/bounties?limit=100&first_party=false');
  },
  async checkDatapoint(env) {
    if (providerMode(env, 'DATAPOINT_PROVIDER') === 'MOCK') return {};
    return fetchJson('https://api.datapoint.market/e/hosamhosaam5/de-lu-day-ahead-hourly');
  },
  async checkBountyBook(env) {
    if (providerMode(env, 'BOUNTYBOOK_PROVIDER') === 'MOCK') return {};
    return fetchJson('https://api.bountybook.ai/stats');
  },
  async loadWatchState(env) {
    const { results } = await env.DB.prepare("SELECT * FROM execution_state WHERE record_kind = 'revenue_watch_state'").all();
    return results || [];
  },
};

export async function runRevenueWatch(env, adapters = defaultAdapters, alertAdapter, logger = console) {
  const [souk, dp, bb, state] = await Promise.all([
    adapters.checkAgentSouk(env), adapters.checkDatapoint(env), adapters.checkBountyBook(env), adapters.loadWatchState(env),
  ]);
  const out = detectDemandEvents({ souk, dp, bb, state });
  const events = out.filter(o => o.item_type === 'event');
  const markers = out.filter(o => o.item_type === 'marker');

  // Save Watch State (upsert markers — same as backup Save Watch State node)
  for (const m of markers) {
    await env.DB.prepare(
      'INSERT INTO execution_state (idempotency_key, record_kind, tool, status, progress, payload_json, updated_at, created_at)\n'
      + 'VALUES (?,?,?,?,?,?,?,?)\n'
      + 'ON CONFLICT(idempotency_key) DO UPDATE SET progress=excluded.progress, payload_json=excluded.payload_json, updated_at=excluded.updated_at'
    ).bind(m.idempotency_key, 'revenue_watch_state', 'revenue_watch', 'WATCHING', m.progress, m.payload_json, m.updated_at, m.created_at).run();
  }

  // Persist only confirmed provider acknowledgements. Failures remain eligible for a later pass.
  let alerted = 0;
  let failed = 0;
  for (const e of events) {
    const key = 'watch|alerted|' + e.alert_key;
    const prior = await env.DB.prepare('SELECT idempotency_key FROM execution_state WHERE idempotency_key = ?').bind(key).first();
    if (prior) continue;
    const messageText = '🔔 ATLAS REVENUE EVENT\n\n' + e.event_kind + '\n' + e.detail + '\n' + e.detected_at;
    try {
      if (!String(env?.FOUNDER_CHAT_ID || '').trim()) {
        throw Object.assign(new Error('FOUNDER_CHAT_ID_NOT_CONFIGURED'), { code: 'FOUNDER_CHAT_ID_NOT_CONFIGURED' });
      }
      if (!alertAdapter || typeof alertAdapter.send !== 'function') {
        throw Object.assign(new Error('TELEGRAM_ALERT_ADAPTER_NOT_CONFIGURED'), { code: 'ADAPTER_NOT_CONFIGURED' });
      }
      const res = await alertAdapter.send(String(env.FOUNDER_CHAT_ID).trim(), messageText, {});
      const messageId = res && (res.message_id ?? res.provider_message_id);
      if (messageId === undefined || messageId === null || String(messageId).trim() === '') {
        throw Object.assign(new Error('TELEGRAM_DELIVERY_NOT_CONFIRMED'), { code: 'DELIVERY_NOT_CONFIRMED' });
      }
      await env.DB.prepare(
        'INSERT INTO execution_state (idempotency_key, record_kind, tool, status, payload_json, created_at, updated_at)\n'
        + 'VALUES (?,?,?,?,?,?,?)\n'
        + 'ON CONFLICT(idempotency_key) DO NOTHING'
      ).bind(key, 'revenue_watch_state', 'revenue_watch', 'SENT', JSON.stringify({ alert_key: e.alert_key, message_id: String(messageId) }), new Date().toISOString(), new Date().toISOString()).run();
      alerted++;
    } catch (error) {
      failed++;
      logger.error('REVENUE_WATCH_ALERT_DELIVERY_FAILED', {
        alert_key: e.alert_key,
        code: String(error?.code || 'DELIVERY_FAILED'),
        error: String(error?.message || error).slice(0, 240),
      });
    }
  }
  return { events_detected: events.length, alerted, failed, markers_saved: markers.length };
}
