import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const mode = process.argv[2];
const env = process.env;
const summary = env.GITHUB_STEP_SUMMARY;
const output = env.GITHUB_OUTPUT;

function fail(message) {
  throw new Error(message);
}

function runWrangler(args) {
  const result = spawnSync('npx', ['--no-install', 'wrangler', ...args], {
    encoding: 'utf8',
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || 'Wrangler command failed').trim();
    fail('Wrangler read operation failed: ' + detail);
  }
  return String(result.stdout || '').trim();
}

function parseJson(text) {
  const start = text.search(/[\\[{]/);
  if (start < 0) fail('Wrangler returned no JSON payload.');
  return JSON.parse(text.slice(start));
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

async function resolveAccountId() {
  const result = spawnSync('npx', ['--no-install', 'wrangler', 'whoami', '--json'], {
    encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) fail('Wrangler account identity lookup failed; verify Account Settings read access.');
  const identity = parseJson(String(result.stdout || '').trim());
  const accounts = Array.isArray(identity.accounts) ? identity.accounts : (Array.isArray(identity.result?.accounts) ? identity.result.accounts : []);
  if (accounts.length !== 1) fail('Expected exactly one accessible Cloudflare account; refusing ambiguous account selection.');
  const accountId = String(accounts[0]?.id || '');
  if (!/^[a-f0-9]{32}$/i.test(accountId)) fail('Wrangler returned no valid account identifier.');
  return accountId;
}

async function resolveDatabase() {
  const accountId = await resolveAccountId();
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
  if (details?.version !== 'production') fail('D1 backend is not production; refusing migration.');
  return { api, databaseId: database.uuid };
}

async function capture() {
  const { api, databaseId } = await resolveDatabase();
  const result = await api('/accounts/' + await resolveAccountId() + '/d1/database/' + databaseId + '/time_travel/bookmark');
  const bookmark = String(result?.bookmark || '');
  if (!bookmark) fail('Cloudflare returned no Time Travel bookmark.');
  const capturedAtMs = Date.now();
  const runId = String(env.GITHUB_RUN_ID || '');
  if (!runId) fail('GITHUB_RUN_ID is missing.');
  appendFileSync(output, 'bookmark=' + bookmark + '\n');
  appendFileSync(output, 'captured_at_ms=' + capturedAtMs + '\n');
  appendFileSync(output, 'captured_run_id=' + runId + '\n');
  appendFileSync(summary, '## Pre-write D1 Time Travel bookmark\n\n- Bookmark: `' + bookmark + '`\n- Captured in workflow run: **' + runId + '**\n- Captured at (UTC): **' + new Date(capturedAtMs).toISOString() + '**\n');
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
  appendFileSync(summary, '- Same-run bookmark freshness guard: **PASS (' + Math.floor(ageMs / 1000) + ' seconds old)**\n');
}

function inspectDemandSignals() {
  const columns = queryRows('PRAGMA table_info(demand_signals)').map(row => String(row.name || ''));
  const countRows = queryRows('SELECT COUNT(*) AS row_count FROM demand_signals');
  const rowCount = Number(countRows[0]?.row_count);
  const tables = queryRows("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('demand_scan_source_runs','demand_source_health')").map(row => String(row.name || '')).sort();
  return { columns, rowCount, tables };
}

function preflight() {
  const state = inspectDemandSignals();
  if (state.columns.length !== 8) fail('Preflight mismatch: expected demand_signals to have 8 columns; observed ' + state.columns.length + '.');
  if (state.rowCount !== 23) fail('Preflight mismatch: expected 23 demand_signals rows; observed ' + state.rowCount + '.');
  if (state.tables.length !== 0) fail('Preflight mismatch: demand observability tables already exist; refusing to apply 0006.');
  appendFileSync(summary, '\n## D1 apply-0006 preflight\n\n- demand_signals columns: **8 / 8**\n- demand_signals rows: **23 / 23**\n- demand_scan_source_runs: **absent**\n- demand_source_health: **absent**\n- Migration allowlist: **migrations/0006_demand_observability.sql only**\n');
}

function verify() {
  const state = inspectDemandSignals();
  const requiredColumns = ['source_url', 'last_verified_at'];
  if (state.columns.length !== 10) fail('Postflight mismatch: expected 10 demand_signals columns; observed ' + state.columns.length + '.');
  for (const column of requiredColumns) {
    if (!state.columns.includes(column)) fail('Postflight mismatch: expected demand_signals column ' + column + ' is missing.');
  }
  const expectedTables = ['demand_scan_source_runs', 'demand_source_health'];
  if (state.tables.length !== 2 || expectedTables.some(name => !state.tables.includes(name))) {
    fail('Postflight mismatch: expected both demand observability tables to exist.');
  }
  if (state.rowCount !== 23) fail('Postflight mismatch: expected demand_signals to remain at 23 rows; observed ' + state.rowCount + '.');
  appendFileSync(summary, '\n## D1 apply-0006 postflight\n\n- demand_signals columns: **10 / 10**\n- demand_signals rows: **23 / 23 (unchanged)**\n- demand_scan_source_runs: **present**\n- demand_source_health: **present**\n');
}

try {
  if (mode === 'capture') await capture();
  else if (mode === 'guard') guard();
  else if (mode === 'preflight') preflight();
  else if (mode === 'verify') verify();
  else fail('Unknown mode. Use capture, guard, preflight, or verify.');
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(1);
}
