// DAILY CEO REPORT — ported from backup workflow "ATLAS — Daily CEO Report" (iafLlZo56B93v4n0).
// Same logic: Assemble Inputs → Build Report → Split Chunks → Sanitize For Html →
// Send (MOCK delivery adapter) → Record Delivery → Save Report State (idempotent).
// Idempotency: report|YYYY-MM-DD (Riyadh) — a second run on the same day skips, exactly
// like the backup's already_sent check.

// ---- Assemble Inputs: load the live operational sources used by the report ----
export async function assembleInputs(env, adapters) {
  const [state, zatca, pubs, assetsRaw, watchRaw, events, tasks, agents, growthRuns, growthAssets, orders, approvals, products] = await Promise.all([
    adapters.loadExecutionState(env),
    adapters.loadZatcaRequests(env),
    adapters.loadPublications(env),
    adapters.loadAcquisitionAssets(env),
    adapters.loadChannelWatch(env),
    adapters.loadEvents ? adapters.loadEvents(env) : [],
    adapters.loadAgentTasks ? adapters.loadAgentTasks(env) : [],
    adapters.loadAgents ? adapters.loadAgents(env) : [],
    adapters.loadGrowthRuns ? adapters.loadGrowthRuns(env) : [],
    adapters.loadGrowthAssets ? adapters.loadGrowthAssets(env) : [],
    adapters.loadOrders ? adapters.loadOrders(env) : [],
    adapters.loadApprovals ? adapters.loadApprovals(env) : [],
    adapters.loadProducts ? adapters.loadProducts(env) : [],
  ]);
  const RIYADH = 3 * 3600 * 1000;
  const date = new Date(Date.now() + RIYADH).toISOString().slice(0, 10);
  const reportId = 'report|' + date;
  const alreadySent = state.some(r => r.idempotency_key === reportId && r.status === 'SENT');
  return {
    state, zatca, pubs,
    assets: (assetsRaw || []).filter(r => Object.keys(r).length > 0),
    watch: (watchRaw || []).filter(r => Object.keys(r).length > 0),
    events: events || [], tasks: tasks || [], agents: agents || [],
    growthRuns: growthRuns || [], growthAssets: growthAssets || [],
    orders: orders || [], approvals: approvals || [], products: products || [],
    date, report_id: reportId, already_sent: alreadySent
  };
}

// Compare SQL/ISO timestamps against the Riyadh calendar day using UTC boundaries.
// Riyadh is UTC+03:00 year-round; stored D1 timestamps are UTC.
function dayBounds(date) {
  const start = new Date(date + 'T00:00:00+03:00');
  const end = new Date(start.getTime() + 86400000);
  const sql = d => d.toISOString().slice(0, 19).replace('T', ' ');
  return { start: sql(start), end: sql(end) };
}
function inDay(value, bounds) {
  if (!value) return false;
  const ts = String(value).slice(0, 19).replace('T', ' ');
  return ts >= bounds.start && ts < bounds.end;
}

// ---- Build Report: concise, sourced metrics; distinguish activity from revenue ----
export function buildReport(input) {
  if (input.already_sent) return { skip: true, report_id: input.report_id, chunks: [] };
  const bounds = dayBounds(input.date);
  const todayEvents = (input.events || []).filter(e => inDay(e.created_at, bounds));
  const todayTasks = (input.tasks || []).filter(t => inDay(t.created_at, bounds));
  const todayRuns = (input.growthRuns || []).filter(r => inDay(r.started_at, bounds));
  const todayZatca = (input.zatca || []).filter(r => inDay(r.submitted_at, bounds));
  const todayPubs = (input.pubs || []).filter(r => inDay(r.publication_time, bounds));
  const activeAgents = (input.agents || []).filter(a => String(a.status || '').toUpperCase() === 'ACTIVE');
  const publishedAssets = (input.growthAssets || []).filter(a => String(a.status || '').toUpperCase() === 'PUBLISHED');
  const activeProducts = (input.products || []).filter(p => String(p.status || '').toUpperCase() === 'ACTIVE');
  const pendingApprovals = (input.approvals || []).filter(a => String(a.status || '').toUpperCase() === 'PENDING');
  const realLedgerClaims = (input.orders || []).filter(o =>
    String(o.settlement_mode || '').toUpperCase() === 'REAL' &&
    String(o.payment_status || '').toUpperCase() === 'PAID' &&
    String(o.chain_id || '') === 'eip155:8453' &&
    /^0x[0-9a-fA-F]{64}$/.test(String(o.tx_hash || '')) &&
    String(o.product_id || '').trim() !== '' &&
    String(o.client_email || '').trim() !== ''
  );
  const mockOrders = (input.orders || []).filter(o => ['MOCK','SIMULATION','TESTNET'].includes(String(o.settlement_mode || '').toUpperCase()));
  const completedTasks = todayTasks.filter(t => ['COMPLETED','SUCCEEDED','DONE','DELIVERED'].includes(String(t.status || '').toUpperCase()));
  const failedEvents = todayEvents.filter(e => /FAIL|ERROR|REVIEW|CRASH/i.test(String(e.status || '')));
  const failedOrdersToday = (input.orders || []).filter(o => inDay(o.created_at, bounds) && /FAIL|ERROR|REVIEW|REJECT/i.test(String(o.status || '')));
  const bySource = {};
  for (const t of todayTasks) { const k = t.source || 'غير محدد'; bySource[k] = (bySource[k] || 0) + 1; }
  const L = [];
  L.push('📊 ATLAS | التقرير اليومي');
  L.push('📅 ' + input.date + ' — توقيت الرياض (UTC+3)');
  L.push('');
  L.push('━━━━━━━━━━━━━━━━');
  L.push('🔎 الملخص التنفيذي');
  L.push('• نشاط تشغيلي: ' + todayTasks.length + ' مهام جديدة، ' + todayRuns.length + ' دورات نمو، ' + todayEvents.length + ' أحداث واردة.');
  L.push('• وكلاء نشطون: ' + activeAgents.length + ' | أصول اكتشاف منشورة: ' + publishedAssets.length);
  L.push('• عملاء/طلبات زاتكا اليوم: ' + todayZatca.length + ' | طلبات مدفوعة موثقة: 0');
  L.push('');
  L.push('⚙️ التشغيل اليوم');
  L.push('• مهام مكتملة: ' + completedTasks.length + ' من ' + todayTasks.length + ' مهمة جديدة.');
  if (Object.keys(bySource).length) L.push('• مصادر المهام: ' + Object.entries(bySource).map(([k,v]) => k + ' ' + v).join('، '));
  else L.push('• لا توجد مهام جديدة مسجلة في جدول المهام اليوم.');
  L.push('• دورات النمو المكتملة: ' + todayRuns.filter(r => String(r.status).toUpperCase() === 'COMPLETED').length + ' من ' + todayRuns.length + '.');
  L.push('');
  L.push('🧩 المنتج والظهور');
  if (activeProducts.length) {
    for (const p of activeProducts.slice(0, 3)) L.push('• ' + (p.name || p.product_id) + ' — ' + (p.pricing_mode === 'FOUNDER_QUOTE' ? 'السعر يتطلب عرضًا معتمدًا' : (p.price_usdc != null ? p.price_usdc + ' USDC' : 'السعر غير محدد')));
  } else L.push('• لم يُعثر على منتج ACTIVE في مصدر المنتجات.');
  L.push('• أصول الاكتشاف المنشورة: ' + publishedAssets.map(a => a.asset_type || a.title || a.slug).join('، ') + (publishedAssets.length ? '' : 'لا يوجد'));
  if (todayPubs.length) for (const p of todayPubs) L.push('• نشر مسجل: ' + (p.channel || '-') + ' — ' + (p.status || '-'));
  else L.push('• لا توجد عملية نشر جديدة مسجلة اليوم؛ لم ننشئ إدراجات أو نرسل مراسلات.');
  L.push('');
  L.push('💰 المبيعات والمالية');
  L.push('• إيراد موثق: 0 USDC — لا توجد دفعة حقيقية مثبتة على السلسلة في بيانات السجل الحالية.');
  L.push('• سجلات الطلبات التجريبية/المحاكاة المستبعدة: ' + mockOrders.length + ' (ليست إيرادًا).');
  L.push('• سجلات REAL المستوفية لحقول الفحص الأولي: ' + realLedgerClaims.length + '؛ لا تُعد إثباتًا on-chain دون تحقق مستقل.');
  L.push('• المصروفات: لا يوجد سجل مصروفات موثق؛ لا أستنتج أنها صفر من غياب البيانات.');
  L.push('');
  L.push('🛡️ الأعطال والموافقات');
  L.push('• أحداث اليوم التي تحمل حالة فشل/مراجعة: ' + failedEvents.length);
  L.push('• طلبات اليوم المرفوضة أو التي تحتاج مراجعة: ' + failedOrdersToday.length);
  L.push('• موافقات المؤسس المعلقة: ' + pendingApprovals.length);
  L.push('');
  L.push('📚 نطاق البيانات');
  L.push('• المصادر: event_log، agent_tasks، agent_identity، growth_runs، growth_assets، order_ledger، financial_approvals، publications، طلبات زاتكا.');
  L.push('• صفر في مقياس معين يعني عدم وجود سجل مطابق في مصدره ضمن يوم الرياض؛ لا يعني أن النظام كله لم يعمل.');
  L.push('• التقرير لا ينشئ إدراجات ولا يرسل رسائل تسويقية أو التزامات خارجية.');
  L.push('');
  L.push('🧭 الخطوة التالية');
  L.push('• استمرار فحص الروابط العامة وأصول الاكتشاف الحالية مجانًا، ومراقبة صحة الخدمة والقياس دون مراسلات أو إدراجات جديدة.');
  L.push('');
  L.push('🧾 الدليل: ' + input.report_id + ' | مهام اليوم=' + todayTasks.length + ' | دورات النمو=' + todayRuns.length + ' | إيراد موثق=0');
  const MAX = 3600; const chunks = []; let cur = '';
  for (const line of L) { const next = cur ? cur + '\n' + line : line; if (next.length > MAX) { chunks.push(cur); cur = line; } else cur = next; }
  if (cur) chunks.push(cur);
  return { skip: false, report_id: input.report_id, date: input.date, chunks, total_chunks: chunks.length,
    stats: { events_today: todayEvents.length, tasks_today: todayTasks.length, growth_runs_today: todayRuns.length, agents_active: activeAgents.length, zatca_today: todayZatca.length, verified_revenue_usdc: 0 } };
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
// Default D1 adapters. Every metric is sourced from the table that actually owns it.
export const defaultAdapters = {
  async loadExecutionState(env) { const { results } = await env.DB.prepare('SELECT * FROM execution_state').bind().all(); return results || []; },
  async loadZatcaRequests(env) { const { results } = await env.DB.prepare('SELECT * FROM zatca_experiment_requests').bind().all(); return results || []; },
  async loadPublications(env) { const { results } = await env.DB.prepare('SELECT * FROM publications').bind().all(); return results || []; },
  async loadAcquisitionAssets(env) { const { results } = await env.DB.prepare('SELECT * FROM acquisition_assets').bind().all(); return results || []; },
  async loadChannelWatch(env) { const { results } = await env.DB.prepare('SELECT * FROM channel_watch').bind().all(); return results || []; },
  async loadEvents(env) { const { results } = await env.DB.prepare('SELECT source, status, created_at FROM event_log').bind().all(); return results || []; },
  async loadAgentTasks(env) { const { results } = await env.DB.prepare('SELECT task_id, source, status, created_at, updated_at FROM agent_tasks').bind().all(); return results || []; },
  async loadAgents(env) { const { results } = await env.DB.prepare('SELECT identity_id, display_name, status FROM agent_identity').bind().all(); return results || []; },
  async loadGrowthRuns(env) { const { results } = await env.DB.prepare('SELECT run_id, status, started_at, finished_at FROM growth_runs').bind().all(); return results || []; },
  async loadGrowthAssets(env) { const { results } = await env.DB.prepare('SELECT asset_id, asset_type, slug, title, status, updated_at FROM growth_assets').bind().all(); return results || []; },
  async loadOrders(env) { const { results } = await env.DB.prepare('SELECT order_id, client_email, tx_hash, status, payment_status, settlement_mode, chain_id, product_id, created_at FROM order_ledger').bind().all(); return results || []; },
  async loadApprovals(env) { const { results } = await env.DB.prepare('SELECT approval_id, status, action, created_at FROM financial_approvals').bind().all(); return results || []; },
  async loadProducts(env) { const { results } = await env.DB.prepare('SELECT product_id, name, status, pricing_mode, price_usdc FROM products').bind().all(); return results || []; },
};

// Orchestration with an atomic daily claim. Only one concurrent cron invocation
// can create the report row; every other invocation exits before Telegram is called.
export async function runDailyReport(env, adapters = defaultAdapters, deliveryAdapter) {
  const input = await assembleInputs(env, adapters);
  const report = buildReport(input);
  const items = sanitizeForHtml(splitChunks(report));
  if (report.skip || items.length === 0) {
    return { status: report.skip ? 'SKIPPED_ALREADY_SENT' : 'NO_CONTENT', report_id: report.report_id, chunks_sent: 0 };
  }

  const now = new Date().toISOString();
  // The PRIMARY KEY on idempotency_key is the concurrency guard. Claim before send,
  // not after send: simultaneous cron triggers cannot all pass a read-then-send check.
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO execution_state (idempotency_key, record_kind, tool, status, payload_json, created_at, updated_at, delivery_state, entity_type, entity_id) VALUES (?, 'atlas_report', 'daily_report', 'SENDING', ?, ?, ?, 'SENDING', 'report', ? ) RETURNING idempotency_key"
  ).bind(report.report_id, JSON.stringify({ report: { date: report.date, state: 'SENDING', claimed_at: now } }), now, now, report.report_id).first();
  if (!claim) {
    return { status: 'SKIPPED_DUPLICATE_OR_REVIEW', report_id: report.report_id, chunks_sent: 0 };
  }

  const chatId = env.FOUNDER_CHAT_ID || '5246182877';
  const messageIds = [];
  let sendErrors = 0;
  for (const it of items) {
    try {
      const res = await deliveryAdapter.send(chatId, it.text, { parse_mode: 'HTML' });
      if (res && res.message_id) messageIds.push(String(res.message_id));
      else sendErrors++;
    } catch (e) {
      sendErrors++;
    }
  }
  const finalStatus = messageIds.length === items.length ? 'SENT' : (messageIds.length > 0 ? 'PARTIAL' : 'DELIVERY_FAILED');
  const deliveryRecord = recordDelivery(messageIds, report.report_id);
  const payload = JSON.stringify({ report: { date: report.date, message_ids: messageIds, message_key: deliveryRecord?.message_key || report.report_id + '|msg|' + messageIds.join(','), chunks_total: items.length, chunks_sent: messageIds.length, send_errors: sendErrors, sent_at: new Date().toISOString(), stats: report.stats } });
  await env.DB.prepare(
    "UPDATE execution_state SET status=?, payload_json=?, delivery_state=?, message_key=?, progress=?, updated_at=? WHERE idempotency_key=? AND status='SENDING'"
  ).bind(finalStatus, payload, finalStatus, report.report_id + '|msg|' + messageIds.join(','), items.length ? messageIds.length / items.length : 0, new Date().toISOString(), report.report_id).run();

  return { status: finalStatus, report_id: report.report_id, chunks_sent: messageIds.length, chunks_total: items.length, recorded: true, stats: report.stats };
}
