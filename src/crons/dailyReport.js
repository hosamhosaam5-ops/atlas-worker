// DAILY CEO REPORT — ported from backup workflow "ATLAS — Daily CEO Report" (iafLlZo56B93v4n0).
// Same logic: Assemble Inputs → Build Report → Split Chunks → Sanitize For Html →
// Send (MOCK delivery adapter) → Record Delivery → Save Report State (idempotent).
// Idempotency: report|YYYY-MM-DD (Riyadh) — a second run on the same day skips, exactly
// like the backup's already_sent check.

// ---- Assemble Inputs (ported from backup "Assemble Inputs") ----
export async function assembleInputs(env, adapters) {
  const state = await adapters.loadExecutionState(env);
  const zatca = await adapters.loadZatcaRequests(env);
  const pubs = await adapters.loadPublications(env);
  const assets = (await adapters.loadAcquisitionAssets(env)).filter(r => Object.keys(r).length > 0);
  const watch = (await adapters.loadChannelWatch(env)).filter(r => Object.keys(r).length > 0);
  const RIYADH = 3 * 3600 * 1000;
  const date = new Date(Date.now() + RIYADH).toISOString().slice(0, 10);
  const reportId = 'report|' + date;
  const alreadySent = state.some(r => r.idempotency_key === reportId && r.status === 'SENT');
  return { state, zatca, pubs, assets, watch, date, report_id: reportId, already_sent: alreadySent };
}

// ---- Build Report (ported VERBATIM from backup "Build Report" code node) ----
export function buildReport(input) {
  if (input.already_sent) return { skip: true, report_id: input.report_id, chunks: [] };
  const dayStart = input.date + "T00:00:00";
  function parse(r) { try { return r.payload_json ? JSON.parse(r.payload_json) : {}; } catch (e) { return {}; } }
  const agents = {}, tasks = {}, events = [];
  for (const r of input.state) {
    const key = String(r.idempotency_key || ""); const pay = parse(r);
    if (key.indexOf("agent|") === 0) agents[(pay.agent || {}).agent_id || key] = pay.agent || {};
    else if (key.indexOf("task|") === 0) tasks[(pay.task || {}).task_id || key] = pay.task || {};
    else if (key.indexOf("evt|") === 0) events.push(pay.event || {});
  }
  const todayEvents = events.filter(e => String(e.timestamp || "") >= dayStart);
  const todayZatca = input.zatca.filter(r => String(r.submitted_at || "") >= dayStart);
  const todayPubs = input.pubs.filter(r => String(r.publication_time || "") >= dayStart);
  const assets = input.assets || []; const watch = input.watch || [];
  const readyAssets = assets.filter(a => a.status === "ready");
  const todayWatch = watch.filter(w => String(w.check_date || "") === input.date);
  const newChannel = todayWatch.filter(w => w.verdict !== "NO_SELF_SERVE_CHANNEL_TODAY" && w.status !== "excluded" && w.status !== "conclusion");
  const excludedToday = todayWatch.filter(w => w.status === "excluded");
  const agentList = Object.keys(agents).map(k => agents[k]);
  const taskList = Object.keys(tasks).map(k => tasks[k]);
  const active = agentList.filter(a => a.status === "ACTIVE").length;
  const parked = taskList.filter(t => t.status === "PARKED");
  const completedToday = taskList.filter(t => String(t.completed_at || "") >= dayStart);
  const recoveries = todayEvents.filter(e => e.type === "TASK_RECOVERY");
  const created = todayEvents.filter(e => e.type === "AGENT_CREATED");
  const qual = todayZatca.filter(r => r.qualified === "yes").length;
  const paid = todayZatca.filter(r => r.paid_interest_volunteered === "volunteered").length;
  const L = [];
  L.push("📊 تقرير أطلس اليومي — " + input.date);
  L.push("");
  L.push("1) الملخص التنفيذي");
  L.push("• أحداث اليوم: " + todayEvents.length + " | مهام مكتملة: " + completedToday.length + " | متوقفة: " + parked.length);
  L.push("• وكلاء نشطون: " + active + "/" + agentList.length + " | جدد اليوم: " + created.length);
  L.push("• طلبات زاتكا اليوم: " + todayZatca.length + " (مؤهل: " + qual + "، اهتمام مدفوع: " + paid + ")");
  if (todayEvents.length === 0 && todayZatca.length === 0) L.push("• لا توجد بيانات موثقة جديدة اليوم.");
  L.push("");
  L.push("2) الوكلاء");
  for (const a of agentList) L.push("• " + (a.name || a.agent_id) + " [" + a.status + "] — تنفيذات: " + (a.execution_count || 0) + ", نجاح: " + (a.success_count || 0) + ", فشل: " + (a.failure_count || 0) + ", صحة: " + (a.health_status || "-"));
  L.push("");
  L.push("3) المنتجات");
  L.push("• فحص جاهزية زاتكا (Wave 25) — منشور: HTTP 200 عام. طلبات اليوم: " + todayZatca.length + ".");
  L.push("");
  L.push("4) التسويق");
  if (todayPubs.length === 0) L.push("• لا نشر جديد موثق اليوم.");
  for (const p of todayPubs) L.push("• " + (p.channel || "-") + ": " + (p.asset || "-") + " — " + (p.status || "-"));
  L.push("");
  L.push("5) المبيعات");
  L.push("• Revenue: 0 — لا مبيعات موثقة. فرص (طلبات مؤهلة): " + qual + ".");
  L.push("");
  L.push("6) العملاء");
  L.push("• طلبات جديدة: " + todayZatca.length + " — تُدار عبر تجربة زاتكا.");
  L.push("");
  L.push("7) التجارب");
  L.push("• EXP-ZATCA-W25-2026-09 — نشطة. إجمالي: " + input.zatca.length + "، اليوم: " + todayZatca.length + ".");
  L.push("");
  L.push("8) الأعطال والاسترداد");
  if (recoveries.length === 0) L.push("• لا أعطال مسجلة اليوم.");
  for (const e of recoveries) L.push("• " + (e.task || "-") + ": " + (e.failure_class || "?") + " → " + (e.action || "?"));
  L.push("");
  L.push("9) المهام المتوقفة (PARKED)");
  for (const t of parked) { const rs = (t.blockers && t.blockers[0] && t.blockers[0].reason) || t.failure_reason || "-"; L.push("• " + t.task_id + " — " + String(t.objective || "").slice(0, 60) + " | السبب: " + rs); }
  if (parked.length === 0) L.push("• لا شيء.");
  L.push("");
  L.push("10) المالية");
  L.push("• Revenue: 0 | Expenses: 0 | Net: 0 — لا بيانات مالية موثقة.");
  L.push("");
  L.push("11) مؤشرات الأداء");
  L.push("• مهام: " + taskList.length + " | وكلاء: " + agentList.length + " | طلبات: " + input.zatca.length + " | أحداث اليوم: " + todayEvents.length);
  L.push("");
  L.push("12) قرارات ذاتية");
  const decisions = todayEvents.filter(e => e.type === "ALTERNATIVE_SELECTED" || e.type === "AGENT_CREATED");
  if (decisions.length === 0) L.push("• لا قرارات ذاتية موثقة اليوم.");
  for (const d of decisions) L.push("• " + d.type + ": " + (d.agent || d.to || "-"));
  L.push("");
  L.push("13) موافقات المؤسس المطلوبة");
  const approvals = parked.filter(t => t.blockers && t.blockers[0] && t.blockers[0].needs === "founder_approval");
  if (approvals.length === 0) L.push("• لا شيء يتطلب موافقتك الآن.");
  for (const t of approvals) L.push("• " + t.task_id + ": " + String(t.objective || "").slice(0, 60));
  L.push("");
  L.push("14) خطة الغد");
  L.push("• متابعة تجربة زاتكا، معالجة المهام المتوقفة عند توفر القدرات، استمرار دورة الشركة الذاتية.");
  L.push("");
  L.push("16) أصول الاكتساب والقنوات");
  L.push("• مخزون الأصول الجاهزة: " + readyAssets.length + " (منشور الآن: 0 — لا نشر جماعي بدون قناة حقيقية).");
  if (todayWatch.length === 0) L.push("• فحص القنوات اليوم: لم يُسجَّل فحص جديد اليوم.");
  else L.push("• فحص القنوات اليوم: " + todayWatch.length + " سجل (مستبعد: " + excludedToday.length + ").");
  if (newChannel.length > 0) { L.push("• قناة ذاتية جديدة محتملة:"); for (const c of newChannel) L.push("  - " + (c.channel || "-") + " → " + (c.verdict || "-")); }
  else L.push("• لا قناة اكتساب ذاتية حقيقية متاحة اليوم — الاستثمار في الأصول بدل تكرار البحث.");
  const bySource = {}; for (const r of input.zatca) { const s = r.attr_source || r.source || "unknown"; bySource[s] = (bySource[s] || 0) + 1; }
  const srcKeys = Object.keys(bySource);
  if (srcKeys.length === 0) L.push("• مصادر الزيارات: لا طلبات مسجلة بعد — نظام القياس جاهز (attr_source/campaign/content).");
  else { L.push("• مصادر الطلبات:"); for (const s of srcKeys) L.push("  - " + s + ": " + bySource[s]); }
  L.push("");
  L.push("15) الأدلة");
  L.push("• report_id=" + input.report_id + " | أحداث=" + todayEvents.length + " | وكلاء=" + agentList.length + " | مهام=" + taskList.length);
  const MAX = 3600; const chunks = []; let cur = "";
  for (const line of L) { const next = cur ? cur + "\n" + line : line; if (next.length > MAX) { chunks.push(cur); cur = line; } else cur = next; }
  if (cur) chunks.push(cur);
  return { skip: false, report_id: input.report_id, date: input.date, chunks, total_chunks: chunks.length, stats: { events_today: todayEvents.length, agents: agentList.length, parked: parked.length, zatca_today: todayZatca.length } };
}

// ---- Split Chunks (ported from backup "Split Chunks") ----
export function splitChunks(d) {
  if (d.skip) return [{ skip: true, report_id: d.report_id, text: '' }];
  if (!d.chunks || d.chunks.length === 0) return [];
  return d.chunks.map((c, i) => ({ text: c, report_id: d.report_id, date: d.date, chunk_index: i, total: d.chunks.length }));
}

// ---- Sanitize For Html (ported from backup "Sanitize For Html") ----
export function sanitizeForHtml(items) {
  return items.map(j => {
    if (j.skip) return j;
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return { ...j, text: esc(j.text || '') };
  });
}

// ---- Record Delivery (ported from backup "Record Delivery") ----
export function recordDelivery(sentMessageIds, reportId) {
  const ids = (sentMessageIds || []).filter(Boolean);
  if (ids.length === 0) return null;
  return {
    idempotency_key: reportId,
    record_kind: "atlas_report", correlation_id: "", action_id: "", tool: "daily_report",
    status: "SENT",
    payload_json: JSON.stringify({ report: { date: (reportId || "").slice(7), message_ids: ids, chunks: ids.length, sent_at: new Date().toISOString() } }).slice(0, 4000),
    error_code: "", attempt_count: 1, created_at: new Date().toISOString(), expires_at: "",
    delivery_state: "SENT", message_key: reportId + "|msg|" + ids.join(","), chunk_index: 0, request_id: "",
    entity_type: "report", entity_id: reportId, progress: 1, updated_at: new Date().toISOString()
  };
}

// Default D1 adapters (production wiring; tests inject fixtures).
export const defaultAdapters = {
  async loadExecutionState(env) { const { results } = await env.DB.prepare('SELECT * FROM execution_state').all(); return results || []; },
  async loadZatcaRequests(env) { const { results } = await env.DB.prepare('SELECT * FROM zatca_experiment_requests').all(); return results || []; },
  async loadPublications(env) { const { results } = await env.DB.prepare('SELECT * FROM publications').all(); return results || []; },
  async loadAcquisitionAssets(env) { const { results } = await env.DB.prepare('SELECT * FROM acquisition_assets').all(); return results || []; },
  async loadChannelWatch(env) { const { results } = await env.DB.prepare('SELECT * FROM channel_watch').all(); return results || []; },
};

// Orchestration. deliveryAdapter.send(chatId, text, {parse_mode}) must return {message_id} on
// real success and throw/return falsy on failure (MOCK default — no real Telegram).
// A delivery is recorded SENT only when the adapter reports real success (same as backup:
// Record Delivery returns [] when no message_ids, so no state row is written).
export async function runDailyReport(env, adapters = defaultAdapters, deliveryAdapter) {
  const input = await assembleInputs(env, adapters);
  const report = buildReport(input);
  const items = sanitizeForHtml(splitChunks(report));
  if (report.skip || items.length === 0) {
    return { status: report.skip ? 'SKIPPED_ALREADY_SENT' : 'NO_CONTENT', report_id: report.report_id, chunks_sent: 0 };
  }
  const chatId = env.FOUNDER_CHAT_ID || '5246182877'; // same chat as backup
  const messageIds = [];
  for (const it of items) {
    const res = await deliveryAdapter.send(chatId, it.text, { parse_mode: 'HTML' });
    if (res && res.message_id) messageIds.push(res.message_id);
  }
  const row = recordDelivery(messageIds, report.report_id);
  if (row) {
    await env.DB.prepare(
      `INSERT INTO execution_state (idempotency_key, record_kind, correlation_id, action_id, tool, status, payload_json, error_code, attempt_count, created_at, expires_at, delivery_state, message_key, chunk_index, request_id, entity_type, entity_id, progress, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(idempotency_key) DO UPDATE SET status=excluded.status, payload_json=excluded.payload_json, delivery_state=excluded.delivery_state, message_key=excluded.message_key, updated_at=excluded.updated_at`
    ).bind(row.idempotency_key, row.record_kind, row.correlation_id, row.action_id, row.tool, row.status, row.payload_json, row.error_code, row.attempt_count, row.created_at, row.expires_at, row.delivery_state, row.message_key, row.chunk_index, row.request_id, row.entity_type, row.entity_id, row.progress, row.updated_at).run();
  }
  return {
    status: messageIds.length === items.length ? 'SENT' : (messageIds.length > 0 ? 'PARTIAL' : 'DELIVERY_FAILED'),
    report_id: report.report_id,
    chunks_sent: messageIds.length,
    chunks_total: items.length,
    recorded: !!row,
  };
}
