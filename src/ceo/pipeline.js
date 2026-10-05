// CEO PIPELINE — async orchestration for one Telegram update.
// Production redeploy trigger: Workers AI model resolution verified on main.
// Runs OUTSIDE the webhook request (webhook only logs + enqueues).
// Mirrors the n8n flow: Format Memory → dup precheck → Build Prompt → AI1 → Parse
// → Risk Engine → (tools) → AI2 → persist state/memory → deliver via outbox.
// Failure rules: AI failure never mutates state wrongly, never fabricates delivery,
// never loses the event (event_log rows record every terminal status).

import { formatMemory, memoryQuery } from './memory.js';
import { buildSystemPrompt, buildFinalSystemPrompt } from './prompt.js';
import { runCeoEngine } from './engine.js';
import { parseCeoResponse } from './parser.js';
import { runRiskEngine } from './risk.js';
import { executeActions } from './tools.js';
import { getProvider, chatWithTimeout } from './provider.js';
import { braveSearchRaw } from './webresearch.js';
import { createOutbox, getTelegramProvider } from '../core/outbox.js';
import { checkBudget } from '../autonomy/registry.js';

function hashStr(s) { let h = 0; s = String(s); for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return Math.abs(h).toString(36); }

async function loadStateRows(env) {
  const { results } = await env.DB.prepare('SELECT * FROM execution_state').bind().all();
  // expand payload_json into entity fields (goal/task/...) like n8n data-table rows
  return (results || []).map(r => {
    let payload = null;
    try { payload = r.payload_json ? JSON.parse(r.payload_json) : null; } catch (e) { payload = null; }
    const row = { ...r };
    if (r.entity_type && payload && typeof payload === 'object' && !Array.isArray(payload)) {
      row[r.entity_type] = payload;
    }
    return row;
  });
}

async function loadMemRows(env) {
  const { results } = await env.DB.prepare('SELECT category, content FROM ceo_memory ORDER BY id DESC LIMIT 200').bind().all();
  return results || [];
}

async function upsertStateRows(env, rows) {
  for (const r of rows || []) {
    const key = r.idempotency_key;
    if (!key) continue;
    const entityPayload = r.goal || r.task || r.decision || r.followup || r.learning || r.plan || r.approval || null;
    const payload = r.payload_json !== undefined ? r.payload_json
      : JSON.stringify(entityPayload || {}).slice(0, 900);
    await env.DB.prepare(
      `INSERT INTO execution_state (idempotency_key, record_kind, correlation_id, request_id, entity_type, entity_id, action_id, tool, status, progress, payload_json, error_code, attempt_count, delivery_state, message_key, expires_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(idempotency_key) DO UPDATE SET status=excluded.status, progress=excluded.progress, payload_json=excluded.payload_json, error_code=excluded.error_code, attempt_count=excluded.attempt_count, delivery_state=excluded.delivery_state, updated_at=datetime('now')`
    ).bind(
      key, r.record_kind || null, r.correlation_id || null, r.request_id || null,
      r.entity_type || null, r.entity_id || null, r.action_id || null, r.tool || null,
      r.status || null, r.progress ?? null, payload, r.error_code || '',
      r.attempt_count ?? 0, r.delivery_state || null, r.message_key || null,
      r.expires_at || null
    ).run();
  }
}

async function insertMemories(env, memories) {
  for (const m of memories || []) {
    await env.DB.prepare('INSERT INTO ceo_memory (category, content) VALUES (?, ?)')
      .bind(String(m.category || 'fact').toLowerCase(), String(m.content).slice(0, 900)).run();
  }
}

async function markEvent(env, eventPk, status, error) {
  await env.DB.prepare('UPDATE event_log SET status = ?, error = ? WHERE id = ?')
    .bind(status, error || null, eventPk).run();
}

function currentDatetimeRiyadh() {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return fmt.format(new Date()).replace('T', ' ') + ' (Asia/Riyadh)';
  } catch (e) {
    return new Date().toISOString() + ' (UTC fallback)';
  }
}

// Send via the M5 unified outbox — Telegram goes through the same PENDING->SENDING->SENT/FAILED
// rules as email. SENT only on real adapter success; chunks dedupe per requestId:chunk_N.
// MOCK (default) performs zero network calls; LIVE requires the founder's token at deploy.
async function deliverReply(env, { chatId, reply, requestId, updatePk }) {
  const chunks = [];
  const MAX = 4000;
  const text = String(reply || '');
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));
  if (!chunks.length) chunks.push('');
  const outbox = createOutbox(env.DB);
  const provider = getTelegramProvider(env);
  const deliveries = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const messageKey = requestId + ':chunk_' + ci;
    const res = await outbox.deliver({
      dedupeKey: 'tg|' + messageKey,
      orderId: messageKey,
      channel: 'telegram',
      recipient: chatId,
      text: chunks[ci],
      provider,
      timeoutMs: Number(env.TELEGRAM_TIMEOUT_MS || 15000),
      env,
    });
    const state = res.delivery_status === 'SENT' ? 'SENT' : (res.delivery_status === 'FAILED' ? 'FAILED' : res.delivery_status);
    // delivery audit row in execution_state (same visibility the M2 outbox provided)
    await env.DB.prepare(
      `INSERT INTO execution_state (idempotency_key, record_kind, request_id, status, delivery_state, message_key, payload_json, error_code, updated_at)
       VALUES (?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(idempotency_key) DO UPDATE SET delivery_state=excluded.delivery_state, status=excluded.status, error_code=excluded.error_code, updated_at=datetime('now')`
    ).bind('dlv|' + messageKey, 'delivery', requestId, state === 'SENT' ? 'REPLY_SENT' : 'DELIVERY_' + state, state, messageKey, JSON.stringify({ chunk_index: ci }), res.error || '').run();
    deliveries.push({ messageKey, state, duplicate: res.duplicate || undefined, attempts: res.attempts, error: res.error || undefined });
  }
  return deliveries;
}

export async function processUpdate(env, update, eventPk, timings) {
  const t = (name, fn) => async (...a) => {
    const t0 = Date.now();
    const out = await fn(...a);
    timings[name] = (timings[name] || 0) + (Date.now() - t0);
    return out;
  };
  const msg = update.message || update.edited_message || {};
  const founderMessage = String(msg.text || '');
  const chatId = String(msg.chat && msg.chat.id || '');
  const messageId = msg.message_id;
  const currentDatetime = currentDatetimeRiyadh();

  // Load state + memory (timed)
  const stateRows = await t('load_state', () => loadStateRows(env))();
  const memRows = await t('load_memory', () => loadMemRows(env))();
  const memFmt = formatMemory(memRows);
  const existingCanon = memRows.map(r => String(r.content || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!؟?،,؛:\s]+$/, '').trim());

  // request identity + durable duplicate precheck (pre-AI, 0-cost replay)
  const preParsed = parseCeoResponse('', { chat_id: chatId, message_id: messageId, founder_message: founderMessage, existingMemoryCanon: existingCanon, stateRows });
  const requestId = preParsed.request_id;
  const correlationId = 'corr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

  if (preParsed.duplicate_request && preParsed.prior_final_reply) {
    const deliveries = await deliverReply(env, { chatId, reply: preParsed.prior_final_reply, requestId, updatePk: eventPk });
    await markEvent(env, eventPk, 'PROCESSED_DUPLICATE_REUSED', null);
    return { outcome: 'DUPLICATE_REUSED', request_id: requestId, deliveries };
  }

  const model = env.AI_MODEL || '@cf/zai-org/glm-4.7-flash';
  const provider = getProvider(env);
  const autonomyStartedAt = Date.now();
  const assertAutonomyBudget = async ({tool_calls=0, external_requests=0, retries=0}={}) => {
    const verdict = await checkBudget(env.DB, {
      tool_calls,
      external_requests,
      retries,
      execution_seconds: Math.ceil((Date.now() - autonomyStartedAt) / 1000),
    });
    if (!verdict.allowed) {
      const e = new Error('Autonomy budget exceeded: ' + verdict.violations.join(','));
      e.code = 'AUTONOMY_BUDGET_BLOCKED';
      e.violations = verdict.violations;
      throw e;
    }
    return verdict;
  };

  await assertAutonomyBudget();

  // ---- AI1 ----
  let ai1Raw;
  const systemPrompt = buildSystemPrompt({ current_datetime: currentDatetime, memory_text: memFmt.memory_text });
  try {
    const r = await chatWithTimeout(provider, { model, system: systemPrompt, user: founderMessage, phase: 'initial' });
    ai1Raw = r.content;
    timings.ai1 = timings.ai1 || 0;
  } catch (e) {
    timings.ai1 = timings.ai1 || 0;
    // AI failure: no state mutation, no fabricated reply, event recorded as failed.
    const failReply = 'حدث خطأ أثناء معالجة طلبك (' + (e.code === 'AI_TIMEOUT' ? 'انتهت مهلة مزود الذكاء' : 'تعذر الوصول إلى مزود الذكاء') + '). لم يتم تنفيذ أي إجراء أو تغيير أي حالة. أعد المحاولة لاحقاً.';
    const failDeliveries = await deliverReply(env, { chatId, reply: failReply, requestId, updatePk: eventPk });
    const failDelivery = failDeliveries.find(d => d.state === 'FAILED');
    // Record the actual terminal result. If the honest error reply itself
    // cannot be delivered, do not pretend the founder received it.
    const terminalStatus = failDelivery ? 'DELIVERY_FAILED' : 'AI_FAILED';
    const terminalError = failDelivery
      ? String(failDelivery.error || 'DELIVERY_FAILED')
      : String(e.code || e.message || e);
    await markEvent(env, eventPk, terminalStatus, terminalError);
    // record request failure row so retries don't look like successes
    await upsertStateRows(env, [{
      idempotency_key: 'req|' + requestId,
      record_kind: 'request_result',
      correlation_id: correlationId,
      request_id: requestId,
      status: terminalStatus,
      payload_json: JSON.stringify({ error: String(e.code || e.message || e), deliveries: failDeliveries }).slice(0, 900),
      error_code: terminalError,
      attempt_count: 1
    }]);
    return { outcome: 'AI_FAILED', request_id: requestId, error: String(e.code || e.message || e) };
  }

  // ---- Parse + Risk ----
  let parsed;
  await t('parse', async () => {
    parsed = parseCeoResponse(ai1Raw, { chat_id: chatId, message_id: messageId, founder_message: founderMessage, existingMemoryCanon: existingCanon, stateRows });
  })();
  parsed.correlation_id = correlationId;
  const risked = runRiskEngine(parsed);

  // ---- CEO Engine (deterministic layer) ----
  let ceoOut = null;
  await t('ceo_engine', async () => {
    ceoOut = runCeoEngine({
      request_id: requestId,
      correlation_id: correlationId,
      founder_message: founderMessage,
      chat_id: chatId,
      reply: JSON.stringify({ reply: parsed.reply, actions: parsed.actions, memories: parsed.memories }),
      state_rows: stateRows.filter(r => r.entity_type),
    }, {});
  })();

  // ---- Tools ----
  // Brave pre-fetch (backup: Split Web Research Queries → Brave Search, order preserved 1:1).
  // A provider failure becomes an {error,statusCode} raw item — the action fails with the
  // classified error code; results are NEVER fabricated.
  let toolOut = { results: [], results_text: '', overall_status: 'NO_ACTIONS', tool_used: 'none', state_rows: [] };
  if (risked.has_tool && !risked.skip_duplicate_request) {
    const webActions = (risked.actions || []).filter(a => a && a.tool === 'web_research');
    try {
      await assertAutonomyBudget({tool_calls: Array.isArray(risked.actions) ? risked.actions.length : 0, external_requests: webActions.length});
    } catch (e) {
      toolOut = { results: [], results_text: 'AUTONOMY_BUDGET_BLOCKED: ' + String(e.violations || e.message), overall_status: 'BLOCKED', tool_used: 'none', state_rows: [] };
    }
    const braveItems = [];
    if (toolOut.overall_status !== 'BLOCKED') for (const wa of webActions) {
      try {
        braveItems.push(await t('brave', () => braveSearchRaw(env, (wa.input && wa.input.query) || ''))());
      } catch (e) {
        braveItems.push({ error: { message: String(e && e.message || e) }, statusCode: 0 });
      }
    }
    if (toolOut.overall_status !== 'BLOCKED') await t('tools', async () => {
      toolOut = executeActions(risked, {
        correlation_id: correlationId,
        request_id: requestId,
        stateRows,
        memRows,
        current_datetime: currentDatetime,
        memoryQueryImpl: memoryQuery,
        braveItems,
      });
    })();
  }

  // ---- AI2 (final) ----
  let finalReply = parsed.reply;
  let finalMemories = parsed.memories;
  if (toolOut.overall_status === 'BLOCKED') {
    finalReply += '\n\n(ملاحظة: تم إيقاف الأدوات تلقائياً لأن الطلب تجاوز حدود الاستقلالية الآمنة. لم تُنفذ الأدوات.)';
  }
  if (toolOut.tool_used !== 'none' && toolOut.results.length > 0) {
    try {
      await assertAutonomyBudget({tool_calls: toolOut.results.length, external_requests: 0});
      const r2 = await chatWithTimeout(provider, {
        model,
        system: buildFinalSystemPrompt(),
        user: 'رسالة المؤسس: ' + founderMessage + '\nردك المبدئي: ' + parsed.reply + '\nالأدوات المنفذة ونتائجها: ' + (toolOut.results_text || '(لم تُنفذ أداة)') + '\nOVERALL_STATUS: ' + toolOut.overall_status,
        phase: 'final',
      });
      const p2 = parseCeoResponse(r2.content, { chat_id: chatId, message_id: messageId, founder_message: founderMessage, existingMemoryCanon: existingCanon, stateRows });
      if (typeof p2.reply === 'string' && p2.reply.trim()) finalReply = p2.reply;
      finalMemories = p2.memories;
    } catch (e) {
      // AI2 failure or autonomy budget block: fall back to honest tool-based reply; do NOT fabricate
      const reason = e.code === 'AUTONOMY_BUDGET_BLOCKED' ? 'تجاوز حدود الاستقلالية الآمنة' : (e.code === 'AI_TIMEOUT' ? 'انتهت المهلة' : 'خطأ مزود');
      finalReply = parsed.reply + '\n\n(ملاحظة: تعذر توليد الصياغة النهائية — ' + reason + '. نتائج الأدوات:\n' + toolOut.results_text + ')';
    }
  }

  // never deliver raw JSON blob as the user reply
  try {
    const tt = String(finalReply).trim();
    if (tt.startsWith('{')) {
      const o = JSON.parse(tt);
      if (o && typeof o.reply === 'string' && o.reply.trim()) finalReply = o.reply;
    }
  } catch (e) { /* keep */ }

  // ---- Persist (state + memory) BEFORE delivery ----
  const ceoStateRows = (ceoOut && Array.isArray(ceoOut.state_rows) ? ceoOut.state_rows : []).map(r => ({
    ...r,
    idempotency_key: 'ceo|' + r.entity_type + '|' + r.entity_id,
    record_kind: 'ceo_state',
    tool: 'ceo_engine',
    attempt_count: 0,
    expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
  }));
  await t('persist_state', () => upsertStateRows(env, toolOut.state_rows.concat(ceoStateRows)))();
  const keptMemories = (finalMemories || []).filter(m => !['option', 'unknown'].includes(String(m.category || '').toLowerCase()));
  await t('persist_memory', () => insertMemories(env, keptMemories))();

  // ---- Deliver ----
  // Delivery is authoritative: request_result MUST NOT claim REPLY_SENT before
  // the outbox confirms every chunk. This prevents false-success state when
  // Telegram/provider delivery fails.
  const deliveries = await t('deliver', () => deliverReply(env, { chatId, reply: finalReply, requestId, updatePk: eventPk }))();
  const deliveryFailed = deliveries.some(d => d.state === 'FAILED');
  const deliveryStatus = deliveryFailed ? 'DELIVERY_FAILED' : 'REPLY_SENT';
  const deliveryError = deliveryFailed
    ? String(deliveries.find(d => d.state === 'FAILED')?.error || 'DELIVERY_FAILED')
    : '';

  // request_result row: durable final answer for replay (single writer).
  // It is written AFTER delivery so its status reflects reality.
  await upsertStateRows(env, [{
    idempotency_key: 'req|' + requestId,
    record_kind: 'request_result',
    correlation_id: correlationId,
    request_id: requestId,
    status: deliveryStatus,
    payload_json: JSON.stringify({ final_reply: finalReply, deliveries }).slice(0, 900),
    error_code: deliveryError,
    attempt_count: 1,
  }]);

  await markEvent(env, eventPk, deliveryFailed ? 'DELIVERY_FAILED' : 'PROCESSED', deliveryError || null);
  return {
    outcome: 'PROCESSED',
    request_id: requestId,
    risk: risked.risk,
    blocked: risked.blocked,
    overall_status: toolOut.overall_status,
    memories_saved: keptMemories.length,
    state_rows_written: toolOut.state_rows.length + ceoStateRows.length,
    deliveries,
  };
}
// Workers AI migration verified: model is resolved from AI_MODEL.
