// TELEGRAPH ACQUISITION MONITOR — ported from backup workflow "ATLAS — Telegraph Acquisition Monitor" (9BdaFehxxp4odRvw).
// Same logic: load telegraph zatca requests + alert state → detect new → build alert →
// send (adapter) → record alert (idempotent: telegraph_alert|<request_key>).

// ---- Detect New Requests (ported VERBATIM from backup) ----
export function detectNewRequests(reqs, state) {
  const requests = (reqs || []).filter(r => r && r.id != null && r.request_key);
  const alerted = new Set((state || []).filter(r => r && r.idempotency_key).map(r => r.idempotency_key));
  const out = [];
  const CUSTOMER_STRUCTURE = "NOT_AVAILABLE";
  const REVENUE_STRUCTURE = "NOT_AVAILABLE";
  for (const r of requests) {
    const key = "telegraph_alert|" + String(r.request_key);
    if (alerted.has(key)) continue;
    out.push({
      alert_key: key,
      request_id: r.id,
      request_key: r.request_key,
      submitted_at: r.submitted_at || "",
      attr_content: r.attr_content || "",
      qualified: r.qualified || "review",
      business_type: r.business_type || "",
      revenue_band: r.revenue_band || "",
      customer_stage: CUSTOMER_STRUCTURE,
      revenue_stage: REVENUE_STRUCTURE
    });
  }
  return out;
}

// ---- Build Alert (ported VERBATIM from backup) ----
export function buildAlert(r) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [];
  lines.push("🚨 REAL ZATCA REQUEST — Telegra.ph");
  lines.push("");
  lines.push("Request ID: #" + r.request_id);
  lines.push("Source: telegraph");
  lines.push("Campaign: EXP-ZATCA-W25-2026-09");
  lines.push("Content: " + esc(r.attr_content));
  lines.push("Timestamp: " + esc(r.submitted_at));
  lines.push("Qualified: " + esc(r.qualified));
  lines.push("Business: " + esc(r.business_type) + " | Revenue band: " + esc(r.revenue_band));
  lines.push("");
  lines.push("Customer stage: " + r.customer_stage + " (لا بنية عملاء مبنية)");
  lines.push("Revenue stage: " + r.revenue_stage + " (لا بنية إيراد مبنية)");
  lines.push("");
  lines.push("هذا طلب حقيقي مسجل في zatca_experiment_requests — ليس اختبارًا.");
  return { ...r, text: lines.join(String.fromCharCode(10)) };
}

// ---- Record Alert (ported from backup; returns null when no message_id, like backup's return []) ----
export function recordAlert(src, messageId) {
  if (!messageId) return null;
  const now = new Date().toISOString();
  return {
    idempotency_key: src.alert_key,
    record_kind: "telegraph_alert",
    correlation_id: "", action_id: "", tool: "telegraph_monitor",
    status: "SENT",
    payload_json: JSON.stringify({ alert: { request_key: src.request_key, request_id: src.request_id, attr_content: src.attr_content, telegram_message_id: messageId, sent_at: now } }).slice(0, 3900),
    error_code: "", attempt_count: 1, created_at: now, expires_at: "",
    delivery_state: "SENT", message_key: src.alert_key + "|msg|" + messageId, chunk_index: 0, request_id: "",
    entity_type: "alert", entity_id: src.alert_key, progress: 1, updated_at: now
  };
}

export const defaultAdapters = {
  async loadTelegraphRequests(env) {
    const { results } = await env.DB.prepare("SELECT * FROM zatca_experiment_requests WHERE attr_source = 'telegraph' AND attr_campaign = 'EXP-ZATCA-W25-2026-09'").all();
    return results || [];
  },
  async loadAlertState(env) {
    const { results } = await env.DB.prepare("SELECT * FROM execution_state WHERE record_kind = 'telegraph_alert'").all();
    return results || [];
  },
};

export async function runTelegraphMonitor(env, adapters = defaultAdapters, alertAdapter) {
  const reqs = await adapters.loadTelegraphRequests(env);
  const state = await adapters.loadAlertState(env);
  const fresh = detectNewRequests(reqs, state);
  let alerted = 0;
  for (const r of fresh) {
    const alert = buildAlert(r);
    const res = alertAdapter ? await alertAdapter.send(env.FOUNDER_CHAT_ID || '5246182877', alert.text, { parse_mode: 'HTML' }) : null;
    const mid = res && res.message_id;
    const row = recordAlert(r, mid);
    if (row) {
      alerted++;
      await env.DB.prepare(
        `INSERT INTO execution_state (idempotency_key, record_kind, correlation_id, action_id, tool, status, payload_json, error_code, attempt_count, created_at, expires_at, delivery_state, message_key, chunk_index, request_id, entity_type, entity_id, progress, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(idempotency_key) DO NOTHING`
      ).bind(row.idempotency_key, row.record_kind, row.correlation_id, row.action_id, row.tool, row.status, row.payload_json, row.error_code, row.attempt_count, row.created_at, row.expires_at, row.delivery_state, row.message_key, row.chunk_index, row.request_id, row.entity_type, row.entity_id, row.progress, row.updated_at).run();
    }
  }
  return { new_requests: fresh.length, alerted };
}
