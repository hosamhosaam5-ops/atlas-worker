// ACTION EXECUTOR — deterministic tool implementations + lifecycle engine.
// Ported from backup node "Action Executor". Tools: calculator, datetime, memory_query.
// web_research is intentionally NOT implemented in M2 (needs Brave API — later phase);
// it returns an explicit failure record, never a fake success.
function isDigit(ch) { return ch >= '0' && ch <= '9'; }

export function calc(rawExpr) {
  rawExpr = String(rawExpr || '').split('×').join('*').split('÷').join('/').split('،').join('').split(',').join('');
  function tok(str) {
    const t = []; let i = 0;
    while (i < str.length) {
      const ch = str[i];
      if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
      if (isDigit(ch) || ch === '.') { let n = ''; while (i < str.length && (isDigit(str[i]) || str[i] === '.')) { n += str[i]; i++; } t.push(n); continue; }
      if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' || ch === '(' || ch === ')') { t.push(ch); i++; continue; }
      throw new Error('رمز غير مسموح: ' + ch);
    }
    return t;
  }
  if (!rawExpr.trim()) return 'خطأ: تعبير حسابي فارغ.';
  try {
    const tokens = tok(rawExpr);
    if (!tokens.length) throw new Error('تعبير فارغ');
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    function pE() { let v = pT(); while (peek() === '+' || peek() === '-') { const o = next(); const r = pT(); v = o === '+' ? v + r : v - r; } return v; }
    function pT() { let v = pF(); while (peek() === '*' || peek() === '/' || peek() === '%') { const o = next(); const r = pF(); if ((o === '/' || o === '%') && r === 0) throw new Error('قسمة على صفر'); v = o === '*' ? v * r : (o === '/' ? v / r : v % r); } return v; }
    function pF() { if (peek() === '-') { next(); return -pF(); } if (peek() === '+') { next(); return pF(); } if (peek() === '(') { next(); const v = pE(); if (next() !== ')') throw new Error('قوس غير مغلق'); return v; } const t = next(); const n = Number(t); if (t === undefined || isNaN(n)) throw new Error('رقم غير صالح'); return n; }
    const value = pE();
    if (pos !== tokens.length) throw new Error('بقايا غير مفهومة');
    if (typeof value !== 'number' || !isFinite(value)) throw new Error('نتيجة غير صالحة');
    return rawExpr.trim() + ' = ' + (Math.round(value * 1e10) / 1e10);
  } catch (e) { return 'خطأ في الحساب: ' + e.message; }
}

function hashStrAE(s) { let h = 0; s = String(s); for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return Math.abs(h).toString(36); }
function normInputAE(inp) { const o = (inp && typeof inp === 'object') ? inp : {}; const keys = Object.keys(o).sort(); return keys.map(k => k + '=' + String(o[k]).trim().toLowerCase().replace(/\s+/g, ' ')).join('&'); }
function contentKeyOf(a) { return 'act|' + hashStrAE(a.tool + '|' + normInputAE(a.input)); }

import { webResearchFromBrave, classifyBraveError, evidenceFromBrave } from './webresearch.js';

// classifyToolError — ported from backup (braveRaw branch preserved verbatim).
function classifyToolError(tool, result, braveRaw) {
  const braveCls = classifyBraveError(braveRaw);
  if (braveCls) return braveCls;
  const msg = String(result || '');
  if (msg.includes('لا توجد نتائج بحث')) return { error_code: 'ERR_EMPTY_RESULT', retryable: true };
  if (tool === 'calculator') return { error_code: 'ERR_CALCULATION', retryable: false };
  return { error_code: 'ERR_UNKNOWN', retryable: false };
}

// RETRY_POLICY — ported from backup.
const RETRY_POLICY = { web_research: { max_retries: 1 }, calculator: { max_retries: 1 }, datetime: { max_retries: 0 }, memory_query: { max_retries: 0 }, external: { max_retries: 0 } };

// ctx: { correlation_id, request_id, stateRows, memRows, current_datetime, risk }
export function executeActions(item, ctx) {
  const actions = Array.isArray(item.actions) ? item.actions : [];
  const correlationId = ctx.correlation_id;
  const requestId = ctx.request_id;
  const runNow = new Date().toISOString();

  const stateByKey = new Map();
  for (const sr of (ctx.stateRows || [])) {
    if (!sr || !sr.idempotency_key) continue;
    if (!stateByKey.has(sr.idempotency_key)) stateByKey.set(sr.idempotency_key, sr);
    if (sr.record_kind === 'action_result' && typeof sr.idempotency_key === 'string') {
      const m = sr.idempotency_key.match(/^act\|content\|(.+)$/);
      if (m && !stateByKey.has('act|' + m[1])) stateByKey.set('act|' + m[1], sr);
    }
  }

  function mkRec(a) {
    return { correlation_id: correlationId, action_id: a.action_id || (correlationId + ':' + a.id), id: a.id, idempotency_key: a.idempotency_key || (correlationId + '|' + a.id + '|' + a.tool), request_key: a.request_key || null, tool: a.tool, operation: a.tool, input: a.input || {}, depends_on: a.depends_on !== undefined ? a.depends_on : null, risk: item.risk || 'SAFE', approval_state: 'NOT_REQUIRED', status: 'VALIDATED', attempt_count: 0, retryable: null, error_code: null, lifecycle: [{ state: 'PLANNED', at: runNow }, { state: 'VALIDATED', at: runNow }], attempt_history: [], started_at: null, completed_at: null, result_available: false, result: null, last_transition: null, dependency_state: a.depends_on !== null && a.depends_on !== undefined ? 'PENDING' : 'NONE', resumed: false, can_resume: false };
  }
  function transit(rec, state, reason) {
    const TERMINAL = ['SUCCEEDED', 'FAILED', 'BLOCKED', 'SKIPPED'];
    const last = rec.lifecycle.length ? rec.lifecycle[rec.lifecycle.length - 1].state : null;
    if (last && TERMINAL.includes(last)) return;
    if (state === 'SUCCEEDED' && rec.lifecycle.some(l => l.state === 'SUCCEEDED')) return;
    rec.lifecycle.push({ state, at: new Date().toISOString() });
    rec.status = state;
    rec.last_transition = { from: last, to: state, reason: reason || null, at: new Date().toISOString() };
  }
  function canResume(rec) {
    if (rec.status === 'SUCCEEDED') return { can: false, reason: 'already_succeeded' };
    if (rec.status === 'BLOCKED' && rec.approval_state !== 'APPROVED') return { can: false, reason: 'blocked_without_approval' };
    if (rec.status === 'FAILED' && rec.retryable === true) return { can: true, reason: 'retryable_failure' };
    if (rec.status === 'FAILED') return { can: false, reason: 'non_retryable_failure' };
    if (rec.status === 'SKIPPED' && rec.error_code === 'ERR_DEPENDENCY_FAILED') return { can: true, reason: 'reevaluate_dependency' };
    if (rec.status === 'SKIPPED') return { can: false, reason: 'skipped_' + String(rec.error_code || 'unknown') };
    if (rec.status === 'WAITING_APPROVAL' && rec.approval_state === 'APPROVED') return { can: true, reason: 'approval_granted' };
    return { can: false, reason: 'not_resumable' };
  }
  function resumeAction(a, rec) {
    const ck = contentKeyOf(a);
    const prior = (a.request_key ? stateByKey.get(a.request_key) : null) || stateByKey.get(ck) || null;
    if (!prior || prior.record_kind !== 'action_result' || prior.status !== 'SUCCEEDED') return false;
    let priorPayload = null;
    try { priorPayload = JSON.parse(prior.payload_json || 'null'); } catch (e) { priorPayload = null; }
    rec.status = 'SUCCEEDED';
    rec.lifecycle.push({ state: 'SUCCEEDED', at: new Date().toISOString() });
    rec.last_transition = { from: 'VALIDATED', to: 'SUCCEEDED', reason: 'prior_execution_result_returned', at: new Date().toISOString() };
    rec.resumed = true;
    rec.result_available = true;
    rec.result = (priorPayload && typeof priorPayload.result === 'string' ? priorPayload.result : null) || '(نتيجة تنفيذ سابق — إعادة استخدام)';
    rec.attempt_count = 0;
    rec.completed_at = new Date().toISOString();
    rec.evidence_ref = (priorPayload && priorPayload.evidence_ref) || null;
    return true;
  }

  const IMPL = {
    calculator: (a) => calc(a.input && a.input.expression),
    datetime: () => 'التاريخ والوقت الحالي: ' + ctx.current_datetime,
    memory_query: (a) => {
      const { memoryQuery } = { memoryQuery: ctx.memoryQueryImpl };
      return ctx.memoryQueryImpl(a.input && a.input.query, ctx.memRows);
    },
    // web_research — M3: real implementation via Brave Provider Adapter (BRAVE=MOCK default).
    // Ported from backup IMPL.web_research: webIndex -> braveItems[webIndex] 1:1 mapping.
    web_research: (a, webIndex) => {
      if (webResultsByIndex.has(webIndex)) return webResultsByIndex.get(webIndex);
      const q = String((a.input && a.input.query) || '');
      const brave = braveItems[webIndex];
      const out = webResearchFromBrave(q, brave);
      webResultsByIndex.set(webIndex, out);
      return out;
    },
  };

  // Brave results for this run, pre-fetched by the pipeline (1:1 with web_research actions,
  // same contract as backup Split Web Research Queries → Brave Search order preservation).
  const braveItems = Array.isArray(ctx.braveItems) ? ctx.braveItems : [];
  const webResultsByIndex = new Map();
  let webIndexCounter = 0;

  const results = [];
  const done = new Set();
  const idemLedger = new Map();
  const pending = actions.slice();
  const actionOrder = new Map(actions.map((a, i) => [a.id, i]));

  let progressed = true;
  let guard = 0;
  while (pending.length && progressed && guard < 10) {
    guard++;
    progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const a = pending[i];
      if (a.depends_on !== null && a.depends_on !== undefined && !done.has('action_' + (a.depends_on + 1))) continue;
      const rec = mkRec(a);
      if (resumeAction(a, rec)) {
        results.push(rec); done.add(a.id); pending.splice(i, 1); progressed = true; continue;
      }
      if (idemLedger.has(rec.idempotency_key)) {
        const prior = idemLedger.get(rec.idempotency_key);
        transit(rec, 'REQUESTED');
        transit(rec, 'SKIPPED');
        rec.error_code = 'ERR_DUPLICATE_ACTION'; rec.retryable = false; rec.result_available = prior.result_available; rec.result = '(مكرر — أعيدت نتيجة التنفيذ السابق) ' + String(prior.result || '');
        rec.completed_at = new Date().toISOString();
        results.push(rec); done.add(a.id); pending.splice(i, 1); progressed = true; continue;
      }
      if (a.depends_on !== null && a.depends_on !== undefined) {
        const dep = results.find(r => r.id === 'action_' + (a.depends_on + 1));
        const depFailed = !dep || dep.status !== 'SUCCEEDED';
        rec.dependency_state = depFailed ? (dep ? 'FAILED' : 'MISSING') : 'RESOLVED';
        if (depFailed) {
          transit(rec, 'REQUESTED');
          transit(rec, 'SKIPPED');
          rec.error_code = dep ? 'ERR_DEPENDENCY_FAILED' : 'ERR_DEPENDENCY_MISSING'; rec.retryable = false; rec.completed_at = new Date().toISOString();
          results.push(rec); done.add(a.id); pending.splice(i, 1); progressed = true; continue;
        }
      }
      transit(rec, 'REQUESTED');
      transit(rec, 'EXECUTING');
      rec.started_at = new Date().toISOString();
      rec.attempt_count = 1;
      try {
        const braveRaw = (a.tool === 'web_research') ? braveItems[webIndexCounter] : null;
        const out = (a.tool === 'web_research') ? IMPL.web_research(a, webIndexCounter++) : IMPL[a.tool](a);
        // malformed tool result: normalize non-string/empty to an explicit failure, never success (backup)
        if (a.tool === 'web_research' && typeof out !== 'string') { throw new Error('malformed tool result'); }
        const isErr = typeof out !== 'string' || out.startsWith('خطأ') || out.trim().length === 0;
        rec.completed_at = new Date().toISOString();
        if (isErr) {
          const cls = typeof out !== 'string' ? { error_code: 'ERR_MALFORMED_RESULT', retryable: true } : (out.trim().length === 0 ? { error_code: (a.tool === 'web_research' ? 'ERR_EMPTY_RESULT' : 'ERR_CALCULATION'), retryable: a.tool === 'web_research' } : classifyToolError(a.tool, out, braveRaw));
          rec.error_code = cls.error_code;
          const pol = RETRY_POLICY[a.tool] || RETRY_POLICY.external;
          rec.retryable = cls.retryable && pol.max_retries > 0;
          rec.retry_count = 0; // no automatic retry loops; retryability recorded for future resume
          transit(rec, 'FAILED');
          rec.result = out; rec.result_available = true;
        } else {
          transit(rec, 'SUCCEEDED');
          rec.result = out; rec.result_available = true;
          idemLedger.set(rec.idempotency_key, rec);
        }
      } catch (e) {
        rec.completed_at = new Date().toISOString();
        rec.error_code = 'ERR_INTERNAL'; rec.retryable = false; rec.retry_count = 0;
        transit(rec, 'FAILED');
        rec.result = 'خطأ: ' + e.message; rec.result_available = true;
      }
      rec.attempt_history.push({ attempt_number: rec.attempt_count, status: rec.status, error_code: rec.error_code || null, started_at: rec.started_at, completed_at: rec.completed_at });
      results.push(rec); done.add(a.id); pending.splice(i, 1); progressed = true;
    }
  }
  results.sort((x, y) => (actionOrder.get(x.id) ?? 0) - (actionOrder.get(y.id) ?? 0));
  for (const a of pending) {
    const rec = mkRec(a);
    transit(rec, 'REQUESTED');
    transit(rec, 'SKIPPED');
    rec.error_code = 'ERR_DEPENDENCY_MISSING'; rec.retryable = false; rec.dependency_state = 'MISSING'; rec.completed_at = new Date().toISOString();
    results.push(rec);
  }
  for (const r of results) { const cr = canResume(r); r.can_resume = cr.can; r.resume_reason = cr.reason; }

  // deterministic overall_status
  const succeeded = results.filter(r => r.status === 'SUCCEEDED').length;
  const failed = results.filter(r => r.status === 'FAILED').length;
  const overallStatus = results.length === 0 ? 'NO_ACTIONS'
    : (failed === 0 ? 'SUCCEEDED' : (succeeded > 0 ? 'PARTIAL_SUCCESS' : 'FAILED'));
  const resultsText = results.map(r => '[' + r.tool + ' → ' + r.status + '] ' + String(r.result || '').slice(0, 300)).join('\n');

  // compact durable action_result rows (same shape as backup)
  const stateRowsOut = results.map(r => ({
    idempotency_key: 'act|content|' + hashStrAE(r.tool + '|' + normInputAE(r.input || {})),
    record_kind: 'action_result',
    correlation_id: correlationId,
    request_id: requestId,
    action_id: r.action_id || r.id,
    tool: r.tool,
    status: r.status,
    payload_json: JSON.stringify({ result: String(r.result || '').slice(0, 500), evidence_ref: [] }).slice(0, 900),
    error_code: r.error_code || '',
    attempt_count: r.attempt_count,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  }));


  // Evidence ledger — ported from backup (calculator + web_research branches, global URL dedupe).
  const evidence = [];
  const webEvCounter = { n: 0 };
  for (const r of results) {
    if (r.status !== 'SUCCEEDED') continue;
    if (r.tool === 'calculator') {
      const act = actions.find(a => a.id === r.id);
      evidence.push({ claim: String(r.result), class: 'FACT', verification_level: 'CALCULATED', source: 'calculator', formula: String(act && act.input && act.input.expression || ''), confidence: 'HIGHER_CONFIDENCE', evidence_limit: null, action_id: r.action_id || r.id });
    } else if (r.tool === 'web_research') {
      const wi = webEvCounter.n++;
      const brave = braveItems[wi];
      const query = String((actions.find(a => a.id === r.id) || {}).input?.query || '');
      for (const ev of evidenceFromBrave(brave, wi, query)) { ev.action_id = r.action_id || r.id; evidence.push(ev); }
    }
  }
  const seenG = new Map();
  for (const ev of evidence) {
    if (!ev.source_url) continue;
    if (seenG.has(ev.source_url)) { const firstRef = seenG.get(ev.source_url); if (!firstRef.also_referenced_by) firstRef.also_referenced_by = []; firstRef.also_referenced_by.push(ev.action_id); ev.shared_with = firstRef.action_id; }
    else seenG.set(ev.source_url, ev);
  }

  return { results, action_records: results, results_text: resultsText, overall_status: overallStatus, tool_used: actions.map(a => a.tool).join(',') || 'none', tool_result: resultsText, state_rows: stateRowsOut, evidence };
}
