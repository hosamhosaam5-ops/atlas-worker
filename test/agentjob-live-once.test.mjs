import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAgentJobPosts } from '../src/autonomy/engine.js';

test('ONE-OFF LIVE AgentJob public MCP read-only smoke test', async () => {
  const response = await fetchAgentJobPosts();
  let payload = {};
  try { payload = JSON.parse(response.text || '{}'); } catch {}
  const summary = {
    ok: response.ok,
    status: response.status,
    contentType: response.contentType || null,
    topLevelKeys: Object.keys(payload || {}).slice(0, 20),
    hasError: Boolean(payload?.error),
    resultKeys: Object.keys(payload?.result || {}).slice(0, 20),
    sample: JSON.stringify(payload).slice(0, 1200)
  };
  console.log('AGENTJOB_LIVE_SMOKE', JSON.stringify(summary));
  assert.equal(response.ok, true, 'AgentJob MCP initialize/list_posts must return a successful HTTP response');
  assert.equal(Boolean(payload?.error), false, 'AgentJob MCP returned a JSON-RPC error');
  assert.ok(payload && typeof payload === 'object', 'AgentJob MCP response must decode to an object');
});
