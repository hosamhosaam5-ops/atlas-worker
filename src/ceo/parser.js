// AI RESPONSE PARSER — ported from backup node "Parse CEO Response".
// Envelope extraction (top-level / nested reply / JSON-string reply / fenced /
// prose-wrapped / plain text), tool whitelist, dedupe, dependency validation,
// cycle detection (Kahn), depth limit 3, deterministic request identity.
const ALLOWED_TOOLS = ['calculator', 'datetime', 'memory_query', 'web_research'];

function stripFencesP(s) {
  return String(s || '').replace(/```json/gi, '').replace(/```/g, '').trim();
}
function tryParseP(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function sliceJsonP(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end !== -1) return s.slice(start, end + 1);
  const rest = s.slice(start);
  const lastBrace = rest.lastIndexOf('}');
  return lastBrace > 0 ? rest.slice(0, lastBrace + 1).replace(/}+$/, '}') : null;
}
function isEnvelopeP(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o) && (typeof o.reply === 'string' || Array.isArray(o.actions));
}
function hashStr(s) { let h = 0; s = String(s); for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return Math.abs(h).toString(36); }
function normInput(inp) { const o = (inp && typeof inp === 'object') ? inp : {}; const keys = Object.keys(o).sort(); return keys.map(k => k + '=' + String(o[k]).trim().toLowerCase().replace(/\s+/g, ' ')).join('&'); }

// identity: hash(chat_id + ':' + message_id); non-durable fallback flags itself.
export function requestIdentity(chatId, messageId, founderMessage) {
  const hasMsgId = messageId !== undefined && messageId !== null && String(messageId) !== '';
  return {
    request_id: hasMsgId ? ('req_' + hashStr(String(chatId) + ':' + String(messageId))) : ('req_nondurable_' + hashStr(String(chatId) + ':' + String(founderMessage || ''))),
    request_identity_durable: hasMsgId,
  };
}

export function parseCeoResponse(raw, ctx) {
  // ctx: { chat_id, message_id, founder_message, existingMemoryCanon: [] , stateRows: [] }
  raw = String(raw || '');
  let parsed = { reply: raw, memories: [], actions: [], parse_status: 'plain_text' };

  // envelope extraction, bounded unwrap depth 2
  let o = tryParseP(stripFencesP(raw));
  for (let depth = 0; depth < 2 && o; depth++) {
    if (isEnvelopeP(o)) {
      // case C: reply field itself is a JSON string
      if (typeof o.reply === 'string') {
        const inner = tryParseP(stripFencesP(o.reply));
        if (inner && isEnvelopeP(inner)) { o = inner; continue; }
      }
      parsed = { reply: typeof o.reply === 'string' ? o.reply : raw, memories: Array.isArray(o.memories) ? o.memories : [], actions: Array.isArray(o.actions) ? o.actions : [], parse_status: 'envelope' };
      o = null;
    } else { o = null; }
  }
  if (parsed.parse_status === 'plain_text') {
    const sliced = sliceJsonP(raw);
    const o2 = sliced ? tryParseP(sliced) : null;
    if (o2 && isEnvelopeP(o2)) {
      parsed = { reply: typeof o2.reply === 'string' ? o2.reply : raw, memories: Array.isArray(o2.memories) ? o2.memories : [], actions: Array.isArray(o2.actions) ? o2.actions : [], parse_status: 'embedded_envelope' };
    }
  }

  // actions: whitelist + malformed-input reject + dedupe + cap 4
  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const rawActionCount = rawActions.length;
  const seen = new Set();
  parsed.actions = rawActions.filter(a => {
    if (!a || typeof a !== 'object') return false;
    if (typeof a.tool !== 'string' || !ALLOWED_TOOLS.includes(a.tool)) return false;
    if (a.input !== undefined && a.input !== null && (typeof a.input !== 'object' || Array.isArray(a.input))) return false;
    const key = a.tool + '|' + JSON.stringify(a.input || {});
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4).map((a, i) => ({
    id: 'action_' + (i + 1),
    tool: a.tool,
    input: (a.input && typeof a.input === 'object' && !Array.isArray(a.input)) ? a.input : {},
    depends_on: (typeof a.depends_on === 'number' && Number.isInteger(a.depends_on)) ? a.depends_on : null
  }));
  if (rawActionCount > parsed.actions.length) parsed.actions_trimmed = rawActionCount - parsed.actions.length;

  // dependency validation: null out bad links, never drop
  parsed.actions.forEach((a, i) => {
    if (a.depends_on !== null) {
      if (typeof a.depends_on !== 'number' || !Number.isInteger(a.depends_on) ||
          a.depends_on < 0 || a.depends_on >= parsed.actions.length || a.depends_on === i) {
        a.depends_on = null;
      }
    }
  });
  // cycle detection (Kahn)
  const n = parsed.actions.length;
  const indeg = parsed.actions.map(() => 0);
  const adj = parsed.actions.map(() => []);
  parsed.actions.forEach((a, i) => { if (a.depends_on !== null && parsed.actions[a.depends_on]) { indeg[i]++; adj[a.depends_on].push(i); } });
  const queue = parsed.actions.map((a, i) => i).filter(i => indeg[i] === 0);
  let visited = 0;
  while (queue.length) { const cur = queue.pop(); visited++; for (const nx of adj[cur]) { indeg[nx]--; if (indeg[nx] === 0) queue.push(nx); } }
  if (visited !== n) { parsed.actions = []; parsed.dependency_cycle = true; }
  // depth limit 3
  parsed.actions = parsed.actions.filter(a => {
    let d = 1, c = a; const seen2 = new Set();
    while (c.depends_on !== null && parsed.actions[c.depends_on] && !seen2.has(parsed.actions.indexOf(c))) {
      seen2.add(parsed.actions.indexOf(c)); c = parsed.actions[c.depends_on]; d++;
      if (d > 3) return false;
    }
    return true;
  });
  // depends_on must reference an EARLIER action
  parsed.actions = parsed.actions.map((a, i) => { if (a.depends_on !== null && a.depends_on >= i) a.depends_on = null; return a; });
  parsed.has_tool = parsed.actions.length > 0;

  // deterministic request identity + idempotency keys
  const idn = requestIdentity(ctx.chat_id, ctx.message_id, ctx.founder_message);
  parsed.request_id = idn.request_id;
  parsed.request_identity_durable = idn.request_identity_durable;
  parsed.correlation_id = 'corr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  parsed.actions = parsed.actions.map((a, i) => {
    const seq = i + 1;
    const actionKey = parsed.request_id + ':action_' + seq;
    return { ...a, action_sequence: seq, action_id: actionKey, idempotency_key: 'act|' + hashStr(actionKey + '|' + a.tool + '|' + normInput(a.input)), request_key: actionKey, lifecycle: ['PLANNED', 'VALIDATED'] };
  });

  // memories: dedupe vs existing + in-batch, conflict detection, conflicts not saved
  const canonMem = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!؟?،,؛:\s]+$/, '').trim();
  const existing = ctx.existingMemoryCanon || [];
  const batchSeen = new Set();
  parsed.memories = (Array.isArray(parsed.memories) ? parsed.memories : [])
    .filter(m => m && typeof m.content === 'string' && m.content.trim().length > 0)
    .filter(m => !existing.includes(canonMem(m.content)))
    .filter(m => { const k = canonMem(m.content); if (batchSeen.has(k)) return false; batchSeen.add(k); return true; });
  parsed.memories = parsed.memories.map(m => {
    const txt = m.content.trim().toLowerCase();
    const kv = txt.match(/^(.+?)(?: هو | هي | = |: )(.+)$/);
    if (kv) {
      const subject = kv[1].trim();
      const value = kv[2].trim();
      const clash = existing.find(e => {
        const ekv = e.match(/^(.+?)(?: هو | هي | = |: )(.+)$/);
        return ekv && ekv[1].trim() === subject && ekv[2].trim() !== value;
      });
      if (clash) return { ...m, category: 'conflict', content: 'CONFLICT_DETECTED: proposed="' + m.content + '" vs existing="' + clash + '"' };
    }
    return m;
  });
  parsed.conflicts = parsed.memories.filter(m => m.category === 'conflict');
  parsed.memories = parsed.memories.filter(m => m.category !== 'conflict');
  parsed.founder_message = ctx.founder_message || '';
  parsed.chat_id = ctx.chat_id || '';

  // duplicate precheck from durable state
  const priorState = ctx.stateRows || [];
  const priorReq = priorState.find(r => r.record_kind === 'request_result' && r.request_id === parsed.request_id) || null;
  // M3 fix (real diff from M2, recorded): AI_FAILED request rows must NOT count as a
  // completed prior request — otherwise a transient AI failure permanently suppresses
  // the founder's message (durable DUPLICATE_REUSED forever). Only successful terminal
  // statuses short-circuit.
  parsed.duplicate_precheck = !!(priorReq && (priorReq.status === 'REPLY_SENT' || priorReq.status === 'COMPLETED' || priorReq.status === 'SUCCEEDED'));
  parsed.duplicate_request = parsed.duplicate_precheck;
  parsed.precheck_prior_reply = (() => {
    if (!priorReq) return null;
    try { const pj = JSON.parse(priorReq.payload_json || 'null'); return (pj && typeof pj.final_reply === 'string' && pj.final_reply.trim()) ? pj.final_reply : null; } catch (e) { return null; }
  })();
  parsed.prior_final_reply = parsed.precheck_prior_reply;
  parsed.sent_message_keys = priorState.filter(r => r.record_kind === 'delivery' && r.request_id === parsed.request_id && r.delivery_state === 'SENT').map(r => r.message_key).filter(Boolean);
  return parsed;
}
