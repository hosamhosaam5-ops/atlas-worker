// CHATGPT BRIDGE — ported from backup workflow "ATLAS — ChatGPT Bridge" (y6tOljK9JIngP86W).
// Same contract: POST /bridge/chatgpt with header auth, ops health/read_state/read_tables/read_workflow_metadata.
// Auth is enforced by the shared secret header BEFORE any operation — same as the n8n Webhook
// node's Header Auth: reaching the handler means the secret already matched. The token value is
// never read, compared, logged, or returned (ported behavior).

const WHITELIST = ['read_state', 'read_tables', 'read_workflow_metadata', 'health'];

// Ported verbatim from backup "Parse And Authorize" code node.
export function parseAndAuthorize(body) {
  const src = (body && typeof body === 'object') ? body : {};
  const requestId = 'brg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const op = String(src.operation || '').trim();
  const authResult = 'OK';
  const whitelisted = WHITELIST.indexOf(op) !== -1;
  return {
    request_id: requestId,
    operation: op,
    auth_result: authResult,
    whitelisted: whitelisted,
    reject: authResult !== 'OK' ? 'UNAUTHORIZED' : (!whitelisted ? 'REJECTED' : 'OK'),
    timestamp: new Date().toISOString()
  };
}

// Ported from backup "Build Response" code node; table reads go through D1 adapters.
export async function buildBridgeResponse(env, meta, adapters) {
  const op = meta.operation;
  let data = {};
  const errors = [];
  const status = meta.reject === 'OK' ? 'SUCCESS' : meta.reject;
  if (meta.reject === 'OK') {
    if (op === 'health') {
      data = {
        service: 'ATLAS ChatGPT Bridge',
        version: 'V1',
        mode: 'READ_ONLY',
        capabilities: ['read_state', 'read_tables', 'read_workflow_metadata', 'health'],
        execute: 'NOT_AVAILABLE_IN_V1',
        time: new Date().toISOString()
      };
    } else if (op === 'read_state') {
      data = { atlas_execution_state: await adapters.readExecutionState(env) };
    } else if (op === 'read_tables') {
      const rows = await adapters.readCeoMemory(env);
      data = {
        ceo_memory_count: rows.length,
        ceo_memory_sample: rows.slice(0, 5),
        ceo_state: 'STORED_IN atlas_execution_state WITH record_kind=ceo_state'
      };
    } else if (op === 'read_workflow_metadata') {
      data = {
        bridge: { name: 'ATLAS — ChatGPT Bridge', mode: 'READ_ONLY', version: 'V1' },
        production_executions: 'UNAVAILABLE - requires n8n API key which was intentionally not created in V1',
        draft_diff: 'UNAVAILABLE - requires n8n API key which was intentionally not created in V1'
      };
    }
  }
  const payload = {
    request_id: meta.request_id,
    operation: op || 'UNKNOWN',
    status: status,
    timestamp: new Date().toISOString(),
    data: data,
    errors: errors
  };
  return {
    response: payload,
    audit: {
      request_id: meta.request_id,
      operation: op || 'UNKNOWN',
      status: status,
      auth_result: meta.auth_result,
      timestamp: new Date().toISOString(),
      error_summary: errors.length ? String(errors[0]).slice(0, 200) : ''
    }
  };
}

// Default D1 adapters (used in production wiring; tests inject MOCK adapters).
export const defaultAdapters = {
  async readExecutionState(env) {
    const { results } = await env.DB.prepare('SELECT * FROM execution_state').all();
    return results || [];
  },
  async readCeoMemory(env) {
    const { results } = await env.DB.prepare('SELECT * FROM ceo_memory').all();
    return results || [];
  }
};

export async function handleChatGptBridge(request, env, adapters = defaultAdapters) {
  const secret = env.CHATGPT_BRIDGE_SECRET;
  if (secret) {
    const provided = request.headers.get('x-atlas-bridge-key');
    if (provided !== secret) {
      return new Response(JSON.stringify({ status: 'UNAUTHORIZED' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
  }
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const meta = parseAndAuthorize(body);
  const out = await buildBridgeResponse(env, meta, adapters);
  // Audit Log (backup node): insert row into bridge_audit
  try {
    await env.DB.prepare('INSERT INTO bridge_audit (request_id, operation, status, auth_result, timestamp, error_summary) VALUES (?,?,?,?,?,?)')
      .bind(out.audit.request_id, out.audit.operation, out.audit.status, out.audit.auth_result, out.audit.timestamp, out.audit.error_summary).run();
  } catch (e) { /* audit failure must not break the bridge response */ }
  return new Response(JSON.stringify(out.response), { status: 200, headers: { 'content-type': 'application/json' } });
}
