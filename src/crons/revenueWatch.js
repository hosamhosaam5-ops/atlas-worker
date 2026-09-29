// SMART REVENUE WATCH — ported from backup workflow "ATLAS — Smart Revenue Watch (read-only)" (XHS3xCpLGfPUm3G6).
// Same logic: 3 HTTP checks (MOCK adapters) → Detect Demand Events → Save Watch State
// (upsert) → alert only on real events. Idempotent: seen alert_keys never re-alert.

// ---- Detect Demand Events (ported VERBATIM from backup, HTTP reads via injected jsons) ----
export function detectDemandEvents({ souk, dp, bb, state }) {
  const seen = new Set((state || []).filter(r => r && r.idempotency_key).map(r => r.idempotency_key));
  const events = [];
  function emit(kind, key, detail) {
    if (!seen.has(key)) events.push({ alert_key: key, event_kind: kind, detail: detail, detected_at: new Date().toISOString() });
  }
  const soukJobs = Array.isArray(souk && souk.data) ? souk.data : (Array.isArray(souk) ? souk : []);
  if (soukJobs.length > 0) {
    emit('BUYER_REQUEST_FOUND', 'watch|souk|' + soukJobs.length, 'AgentSouk live open bounties: ' + soukJobs.length);
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

// Default adapters — production wiring (never called in M3 without approval; tests use MOCK).
export const defaultAdapters = {
  async checkAgentSouk() { const r = await fetch('https://api.agentsouk.dev/v1/bounties?status=open', { signal: AbortSignal.timeout(15000) }); return r.json().catch(() => ({})); },
  async checkDatapoint() { const r = await fetch('https://api.datapoint.market/e/hosamhosaam5/de-lu-day-ahead-hourly', { signal: AbortSignal.timeout(15000) }); return r.json().catch(() => ({})); },
  async checkBountyBook() { const r = await fetch('https://api.bountybook.ai/stats', { signal: AbortSignal.timeout(15000) }); return r.json().catch(() => ({})); },
  async loadWatchState(env) {
    const { results } = await env.DB.prepare("SELECT * FROM execution_state WHERE record_kind = 'revenue_watch_state'").all();
    return results || [];
  },
};

export async function runRevenueWatch(env, adapters = defaultAdapters, alertAdapter) {
  const [souk, dp, bb, state] = await Promise.all([
    adapters.checkAgentSouk(), adapters.checkDatapoint(), adapters.checkBountyBook(), adapters.loadWatchState(env),
  ]);
  const out = detectDemandEvents({ souk, dp, bb, state });
  const events = out.filter(o => o.item_type === 'event');
  const markers = out.filter(o => o.item_type === 'marker');

  // Save Watch State (upsert markers — same as backup Save Watch State node)
  for (const m of markers) {
    await env.DB.prepare(
      `INSERT INTO execution_state (idempotency_key, record_kind, tool, status, progress, payload_json, updated_at, created_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(idempotency_key) DO UPDATE SET progress=excluded.progress, payload_json=excluded.payload_json, updated_at=excluded.updated_at`
    ).bind(m.idempotency_key, 'revenue_watch_state', 'revenue_watch', 'WATCHING', m.progress, m.payload_json, m.updated_at, m.created_at).run();
  }

  // Alert founder on real events only (backup: Is Real Event → Alert Founder).
  // Sent alert keys are persisted so a rerun never re-alerts the same event.
  let alerted = 0;
  for (const e of events) {
    const key = 'watch|alerted|' + e.alert_key;
    const prior = await env.DB.prepare('SELECT idempotency_key FROM execution_state WHERE idempotency_key = ?').bind(key).first();
    if (prior) continue;
    const text = '🔔 ATLAS REVENUE EVENT\n\n' + e.event_kind + '\n' + e.detail + '\n' + e.detected_at;
    const res = alertAdapter ? await alertAdapter.send(env.FOUNDER_CHAT_ID || '5246182877', text, {}) : null;
    if (res && res.message_id) {
      alerted++;
      await env.DB.prepare(
        `INSERT INTO execution_state (idempotency_key, record_kind, tool, status, payload_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(idempotency_key) DO NOTHING`
      ).bind(key, 'revenue_watch_state', 'revenue_watch', 'SENT', JSON.stringify({ alert_key: e.alert_key, message_id: res.message_id }), new Date().toISOString(), new Date().toISOString()).run();
    }
  }
  return { events_detected: events.length, alerted, markers_saved: markers.length };
}
