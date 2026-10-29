import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const mode = process.argv[2];
const env = process.env;
const output = env.GITHUB_OUTPUT;
const summary = env.GITHUB_STEP_SUMMARY;
const SOURCE = 'opentask_public_tasks';
const SCOPE = "id BETWEEN 1 AND 23 AND source='opentask_public_tasks'";

function fail(message) { throw new Error(message); }

function runWrangler(args) {
  const result = spawnSync('npx', ['--no-install', 'wrangler', ...args], {
    encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || 'Wrangler command failed')
      .trim().replace(/[a-f0-9]{32}/gi, '[redacted]');
    fail('Wrangler D1 operation failed: ' + detail);
  }
  return String(result.stdout || '').trim();
}

function parseJson(text) {
  const candidates = [text.indexOf('{'), text.indexOf('[')].filter(index => index >= 0).sort((a, b) => a - b);
  for (const start of candidates) {
    const close = text[start] === '{' ? text.lastIndexOf('}') : text.lastIndexOf(']');
    if (close < start) continue;
    try { return JSON.parse(text.slice(start, close + 1)); } catch {}
  }
  fail('Wrangler returned no complete JSON payload.');
}

function rowsFrom(value, arrays = []) {
  if (Array.isArray(value)) {
    if (value.length && value.every(x => x && typeof x === 'object' && !Array.isArray(x) && !('results' in x))) arrays.push(value);
    for (const item of value) rowsFrom(item, arrays);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) rowsFrom(item, arrays);
  }
  return arrays;
}

function queryRows(sql) {
  const raw = runWrangler(['d1', 'execute', 'atlas_db', '--remote', '--command', sql, '--json']);
  const arrays = rowsFrom(parseJson(raw));
  return arrays.sort((a, b) => b.length - a.length)[0] || [];
}

function count(sql) {
  const rows = queryRows(sql);
  const value = Number(rows[0]?.row_count);
  if (!Number.isFinite(value)) fail('D1 count query returned no numeric row_count.');
  return value;
}

async function resolveDatabase() {
  const identityResult = spawnSync('npx', ['--no-install', 'wrangler', 'whoami', '--json'], {
    encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024,
  });
  if (identityResult.status !== 0) fail('Wrangler account identity lookup failed; verify Account Settings read access.');
  const identity = parseJson(String(identityResult.stdout || '').trim());
  const accounts = Array.isArray(identity.accounts) ? identity.accounts : (Array.isArray(identity.result?.accounts) ? identity.result.accounts : []);
  if (accounts.length !== 1) fail('Expected exactly one accessible Cloudflare account; refusing ambiguous account selection.');
  const accountId = String(accounts[0]?.id || '');
  if (!/^[a-f0-9]{32}$/i.test(accountId)) fail('Wrangler returned no valid account identifier.');
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) fail('Missing CLOUDFLARE_API_TOKEN.');
  const api = async (path) => {
    const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    if (!response.ok || data.success !== true) {
      const messages = Array.isArray(data.errors) ? data.errors.map(x => x.message).join('; ') : '';
      fail('Cloudflare D1 API HTTP ' + response.status + (messages ? ': ' + messages : ''));
    }
    return data.result;
  };
  const listed = await api('/accounts/' + accountId + '/d1/database?name=atlas_db&per_page=100');
  const database = Array.isArray(listed) ? listed.find(x => x.name === 'atlas_db') : null;
  if (!database?.uuid) fail('Exact D1 database atlas_db was not returned.');
  const details = await api('/accounts/' + accountId + '/d1/database/' + database.uuid + '?fields=uuid,name,version');
  if (details?.version !== 'production') fail('D1 backend is not production; refusing status update.');
  return { api, accountId, databaseId: database.uuid };
}

async function capture() {
  const { api, accountId, databaseId } = await resolveDatabase();
  const result = await api('/accounts/' + accountId + '/d1/database/' + databaseId + '/time_travel/bookmark');
  const bookmark = String(result?.bookmark || '');
  if (!bookmark) fail('Cloudflare returned no Time Travel bookmark.');
  const capturedAtMs = Date.now();
  const runId = String(env.GITHUB_RUN_ID || '');
  if (!runId || !output) fail('GitHub workflow run context is missing.');
  appendFileSync(output, 'bookmark=' + bookmark + '\n');
  appendFileSync(output, 'captured_at_ms=' + capturedAtMs + '\n');
  appendFileSync(output, 'captured_run_id=' + runId + '\n');
  appendFileSync(summary, '## D1 pre-write bookmark\n\n- Bookmark: `' + bookmark + '`\n- Captured in this workflow run.\n');
}

function guard() {
  const bookmark = String(env.D1_BOOKMARK || '');
  const capturedAt = Number(env.D1_BOOKMARK_CAPTURED_AT_MS || 0);
  const capturedRun = String(env.D1_BOOKMARK_RUN_ID || '');
  const currentRun = String(env.GITHUB_RUN_ID || '');
  if (!bookmark || !capturedAt || !capturedRun || capturedRun !== currentRun) fail('No bookmark captured in this workflow run; refusing D1 write.');
  if (!/^[a-f0-9-]{24,128}$/i.test(bookmark)) fail('Same-run bookmark format is invalid; refusing D1 write.');
  const ageMs = Date.now() - capturedAt;
  if (ageMs < 0 || ageMs >= 2 * 60 * 60 * 1000) fail('Same-run bookmark is not younger than two hours; refusing D1 write.');
  appendFileSync(summary, '- Same-run bookmark freshness guard: **PASS**\n');
}

function preflightMark() {
  const total = count('SELECT COUNT(*) AS row_count FROM demand_signals WHERE ' + SCOPE);
  const qualified = count("SELECT COUNT(*) AS row_count FROM demand_signals WHERE " + SCOPE + " AND status='QUALIFIED'");
  if (total !== 23 || qualified !== 23) {
    fail('Preflight mismatch: expected exactly 23 scoped demand rows and all 23 QUALIFIED; observed total=' + total + ', qualified=' + qualified + '.');
  }
  appendFileSync(summary, '\n## mark-stale preflight\n\n- Scoped rows: **23 / 23**\n- QUALIFIED rows: **23 / 23**\n');
}

function mark() {
  const sql = "UPDATE demand_signals SET status='STALE_UNVERIFIED' WHERE id BETWEEN 1 AND 23 AND source='opentask_public_tasks' AND status='QUALIFIED';";
  runWrangler(['d1', 'execute', 'atlas_db', '--remote', '--command', sql, '--json']);
  appendFileSync(summary, '- Executed the single allowlisted status UPDATE.\n');
}

function verifyMark() {
  const total = count('SELECT COUNT(*) AS row_count FROM demand_signals WHERE ' + SCOPE);
  const stale = count("SELECT COUNT(*) AS row_count FROM demand_signals WHERE " + SCOPE + " AND status='STALE_UNVERIFIED'");
  const qualified = count("SELECT COUNT(*) AS row_count FROM demand_signals WHERE " + SCOPE + " AND status='QUALIFIED'");
  if (total !== 23 || stale !== 23 || qualified !== 0) {
    fail('Postflight mismatch: expected 23 STALE_UNVERIFIED and 0 QUALIFIED; observed total=' + total + ', stale=' + stale + ', qualified=' + qualified + '.');
  }
  appendFileSync(summary, '\n## mark-stale postflight\n\n- Scoped rows: **23 / 23**\n- STALE_UNVERIFIED: **23 / 23**\n- QUALIFIED: **0**\n');
}

function preflightRollback() {
  const total = count('SELECT COUNT(*) AS row_count FROM demand_signals WHERE ' + SCOPE);
  const stale = count("SELECT COUNT(*) AS row_count FROM demand_signals WHERE " + SCOPE + " AND status='STALE_UNVERIFIED'");
  const qualified = count("SELECT COUNT(*) AS row_count FROM demand_signals WHERE " + SCOPE + " AND status='QUALIFIED'");
  if (total !== 23) fail('Rollback preflight mismatch: expected 23 scoped rows; observed ' + total + '.');
  if (stale === 0 && qualified === 23) {
    appendFileSync(output, 'rollback_needed=false\n');
    appendFileSync(summary, '\n## rollback-stale preflight\n\n- No STALE_UNVERIFIED rows found; no rollback write is needed.\n');
    return;
  }
  if (stale < 1 || stale > 23) fail('Rollback preflight found an invalid stale row count; refusing update.');
  appendFileSync(output, 'rollback_needed=true\n');
  appendFileSync(summary, '\n## rollback-stale preflight\n\n- Scoped rows: **23 / 23**\n- STALE_UNVERIFIED rows to restore: **' + stale + '**\n');
}

function rollback() {
  const sql = "UPDATE demand_signals SET status='QUALIFIED' WHERE id BETWEEN 1 AND 23 AND source='opentask_public_tasks' AND status='STALE_UNVERIFIED';";
  runWrangler(['d1', 'execute', 'atlas_db', '--remote', '--command', sql, '--json']);
  appendFileSync(summary, '- Executed the single constrained rollback UPDATE.\n');
}

function verifyRollback() {
  const total = count('SELECT COUNT(*) AS row_count FROM demand_signals WHERE ' + SCOPE);
  const stale = count("SELECT COUNT(*) AS row_count FROM demand_signals WHERE " + SCOPE + " AND status='STALE_UNVERIFIED'");
  const qualified = count("SELECT COUNT(*) AS row_count FROM demand_signals WHERE " + SCOPE + " AND status='QUALIFIED'");
  if (total !== 23 || stale !== 0 || qualified !== 23) {
    fail('Rollback postflight mismatch: expected 23 QUALIFIED and 0 STALE_UNVERIFIED; observed total=' + total + ', stale=' + stale + ', qualified=' + qualified + '.');
  }
  appendFileSync(summary, '\n## rollback-stale postflight\n\n- Scoped rows: **23 / 23**\n- QUALIFIED: **23 / 23**\n- STALE_UNVERIFIED: **0**\n');
}

try {
  if (mode === 'capture') await capture();
  else if (mode === 'guard') guard();
  else if (mode === 'preflight-mark') preflightMark();
  else if (mode === 'mark') mark();
  else if (mode === 'verify-mark') verifyMark();
  else if (mode === 'preflight-rollback') preflightRollback();
  else if (mode === 'rollback') rollback();
  else if (mode === 'verify-rollback') verifyRollback();
  else fail('Unknown d1-stale-status mode.');
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(1);
}
