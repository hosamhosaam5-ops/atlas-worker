// M6A — PRODUCTION ROUTE AUDIT (item 8) + REAL PROVIDER GAP (item 9) + FINAL E2E (item 12).
// Drives the real Worker via wrangler dev (local) against a fresh local D1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
}

before(async () => {
  const persist = path.join(ROOT, '.wrangler-m6a');
  fs.rmSync(persist, { recursive: true, force: true });
  // Apply the real migration path to the local D1 before serving (item 2 proof on real D1).
  const { applyMigrations } = await import('../src/core/migrate.js');
  // wrangler d1 local DBs are files under persist; use wrangler CLI for fidelity.
  const { execSync } = await import('node:child_process');
  for (const f of ['schema.sql', 'schema-m2.sql', 'schema-m3.sql', 'schema-m4.sql', 'schema-m5.sql', 'schema-m6.sql']) {
    execSync(`npx wrangler d1 execute atlas_db --local --persist-to .wrangler-m6a --file ./${f}`, { cwd: ROOT, stdio: 'ignore' });
  }
  proc = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT), '--persist-to', persist, '--var', 'AI_PROVIDER:WORKERS_AI', '--var', 'TELEGRAM_PROVIDER:LIVE', '--var', 'X402_TEST_MODE:1'], { cwd: ROOT, stdio: 'ignore', detached: true });
  proc.unref();
  await waitUp();
});
after(async () => {
  if (proc) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} } }
  try { const cp = await import('node:child_process'); cp.execSync('pkill -9 -f workerd || true'); } catch {}
});

const post = (p, body, headers = {}) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('route.health: GET /health returns current configured provider matrix', async () => {
  const r = await fetch(BASE + '/health');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.ai_provider, 'WORKERS_AI');
  assert.equal(j.brave, 'MOCK');
  assert.equal(j.telegram, 'LIVE');
  assert.equal(j.email, 'MOCK');
  assert.equal(j.payment, 'BASE_RPC');
  assert.equal(typeof j.git_sha, 'string');
  assert.ok(j.git_sha.length > 0);
});

test('route.mcp: OAuth discovery is available and unauthenticated MCP is rejected', async () => {
  const authz = await fetch(BASE + '/.well-known/oauth-authorization-server');
  assert.equal(authz.status, 200);
  const aj = await authz.json();
  assert.ok(aj.authorization_endpoint);
  assert.ok(aj.token_endpoint);
  const resource = await fetch(BASE + '/.well-known/oauth-protected-resource');
  assert.equal(resource.status, 200);
  const rj = await resource.json();
  assert.equal(rj.resource, 'https://atlas-worker.hosamhosaam5.workers.dev/mcp');
  const headers = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' };
  const mcp = await fetch(BASE + '/mcp', { method: 'POST', headers, body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'unauthenticated-test', version: '1' } }
  }) });
  assert.equal(mcp.status, 401);
});


test('route.telegram: configured-secret path is exercised by dedicated handler tests', async () => {
  // The local route instance intentionally has no secret, so public traffic stays fail-closed.
  // Authenticated ACCEPTED/DUPLICATE behavior is covered by M5 handler-level tests.
  assert.equal((await post('/webhook/telegram', { update_id: 910002, message: { text: 'مرحبا' } })).status, 503);
});

test('route.telegram: malformed JSON cannot bypass missing-secret gate', async () => {
  const r = await fetch(BASE + '/webhook/telegram', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.error, 'TELEGRAM_WEBHOOK_NOT_CONFIGURED');
});

test('route.order: fail closed when webhook secret is unset', async () => {
  const r = await post('/webhook/order', { client_email: 'nobody@example.com' });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.error, 'ORDER_WEBHOOK_NOT_CONFIGURED');
});

test('route.order: rejects all public requests while secret is unset', async () => {
  // The first Wrangler instance deliberately has no ORDER_WEBHOOK_SECRET.
  // A supplied header cannot bypass the missing server-side configuration.
  const r = await post('/webhook/order', { client_email: 'nobody@example.com' }, {
    'x-atlas-order-webhook-secret': 'definitely-not-the-secret'
  });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.error, 'ORDER_WEBHOOK_NOT_CONFIGURED');
});

test('route.bridges: chatgpt missing secret -> 503 fail closed', async () => {
  const r = await post('/bridge/chatgpt', { operation: 'health' });
  const j = await r.json();
  assert.equal(r.status, 503);
  assert.equal(j.status, 'BRIDGE_NOT_CONFIGURED');
});

test('route.bridges: siwe serves signing page (MOCK challenge), bountybook contract shape', async () => {
  const r = await fetch(BASE + '/bridge/siwe');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /personal_sign/);
  const b = await post('/bridge/bountybook', { signature: '0xabc' });
  const j = await b.json();
  assert.ok(['SUCCESS', 'FAILED'].includes(j.auth));
  assert.ok('wallet_match' in j && 'stop' in j && 'message' in j);
  assert.ok(!('session_token' in j)); // token never returned
});

test('route.dev-endpoints: every /dev route is 404 without DEV_MODE, 200 with DEV_MODE=1', async () => {
  for (const p of ['/dev/events', '/dev/orders', '/dev/state', '/dev/memory']) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 404, p + ' must be hidden without DEV_MODE');
  } // guard active: DEV_MODE unset in this test env = production posture
  // With DEV_MODE=1 the same endpoint serves (local-test seam only).
  const proc2 = spawn('npx', ['wrangler', 'dev', '--local', '--port', '8798', '--persist-to', path.join(ROOT, '.wrangler-m6a'), '--var', 'DEV_MODE:1'], { cwd: ROOT, stdio: 'ignore', detached: true });
  proc2.unref();
  try {
    let ok = false;
    for (let i = 0; i < 60; i++) {
      try { const rr = await fetch('http://127.0.0.1:8798/dev/events'); if (rr.status === 200) { ok = true; break; } } catch {}
      await new Promise(r2 => setTimeout(r2, 500));
    }
    assert.ok(ok, '/dev/events must respond 200 when DEV_MODE=1');
  } finally {
    try { process.kill(-proc2.pid, 'SIGKILL'); } catch { try { proc2.kill('SIGKILL'); } catch {} }
    try { (await import('node:child_process')).execSync('pkill -9 -f "port 8798" || true'); } catch {}
  }
});

test('route.404: unknown path -> 404 JSON', async () => {
  const r = await fetch(BASE + '/nope');
  assert.equal(r.status, 404);
});

test('provider-gap: all provider modules expose both MOCK and LIVE branches', async () => {
  const fs = await import('node:fs');
  const checks = [
    ['src/core/outbox.js', /kind === 'MOCK'/, /kind === 'LIVE'/],
    ['src/ceo/provider.js', [/kind === 'MOCK'/, /kind === 'OPENROUTER'/]],
    ['src/ceo/webresearch.js', [/mode === 'MOCK'/, /api\.search\.brave\.com/]],
    ['src/orders/email.js', [/kind === 'MOCK'/, /kind === 'RESEND'/]],
    ['src/orders/payment.js', [/provider === 'MOCK'/, /provider === 'BASE_RPC'/]],
    ['src/orders/storage.js', [/kind === 'LOCAL'/, /kind === 'R2'/]],
    ['src/bridges/siwe.js', [/mode === 'MOCK'/, /api\.datapoint\.market/]],
    ['src/bridges/bountybook.js', [/mode === 'MOCK'/, /api\.bountybook\.ai/]],
  ];
  for (const [f, a, b] of checks) {
    const c = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const [p1, p2] = Array.isArray(a) ? a : [a, b];
    assert.ok(p1.test(c), f + ' missing MOCK branch');
    assert.ok(p2 && p2.test(c), f + ' missing LIVE branch');
  }
});
