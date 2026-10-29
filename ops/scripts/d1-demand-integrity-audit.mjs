import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const SUMMARY = process.env.GITHUB_STEP_SUMMARY;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;

function fail(message) {
  throw new Error(message);
}

function parseJson(text) {
  const source = String(text || '');
  const starts = [source.indexOf('{'), source.indexOf('[')].filter(i => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const close = source[start] === '{' ? source.lastIndexOf('}') : source.lastIndexOf(']');
    if (close < start) continue;
    try { return JSON.parse(source.slice(start, close + 1)); } catch {}
  }
  fail('Expected JSON output from a read-only D1 query.');
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

function wrangler(args) {
  const result = spawnSync('npx', ['--no-install', 'wrangler', ...args], {
    encoding: 'utf8', env: process.env, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) fail('A read-only Wrangler operation failed; no row data was printed.');
  return String(result.stdout || '').trim();
}

async function verifyProductionDatabase() {
  if (!TOKEN) fail('Cloudflare token is not configured; refusing to query D1.');
  const whoami = parseJson(wrangler(['whoami', '--json']));
  const accounts = Array.isArray(whoami.accounts) ? whoami.accounts
    : (Array.isArray(whoami.result?.accounts) ? whoami.result.accounts : []);
  if (accounts.length !== 1) fail('Expected exactly one accessible Cloudflare account; refusing ambiguous database selection.');
  const accountId = String(accounts[0]?.id || '');
  if (!/^[a-f0-9]{32}$/i.test(accountId)) fail('Cloudflare account identity could not be verified.');

  const request = async (path) => {
    const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    if (!response.ok || data.success !== true) fail('Cloudflare refused the read-only D1 backend verification.');
    return data.result;
  };

  const listed = await request('/accounts/' + accountId + '/d1/database?name=atlas_db&per_page=100');
  const database = Array.isArray(listed) ? listed.find(item => item.name === 'atlas_db') : null;
  if (!database?.uuid) fail('The exact atlas_db database was not returned; refusing query.');
  const details = await request('/accounts/' + accountId + '/d1/database/' + database.uuid + '?fields=uuid,name,version');
  if (details?.version !== 'production') fail('D1 backend is not verified as production; refusing query.');
}

function queryRows(sql) {
  const raw = wrangler(['d1', 'execute', 'atlas_db', '--remote', '--command', sql, '--json']);
  return rowsFrom(parseJson(raw)).sort((a, b) => b.length - a.length)[0] || [];
}

function count(sql) {
  const rows = queryRows(sql);
  const value = Number(rows[0]?.row_count);
  if (!Number.isFinite(value)) fail('A count-only D1 query returned no numeric result.');
  return value;
}

function safeCount(row) {
  const value = Number(row?.row_count);
  if (!Number.isFinite(value) || value < 0) fail('An aggregate D1 query returned an invalid count.');
  return value;
}

function renderLine(line) {
  console.log(line);
  if (SUMMARY) appendFileSync(SUMMARY, line + '\n');
}

async function main() {
  await verifyProductionDatabase();

  const statusRows = queryRows(
    'SELECT status, COUNT(*) AS row_count FROM demand_signals GROUP BY status ORDER BY status'
  );
  const outsideScope = count(
    'SELECT COUNT(*) AS row_count FROM demand_signals WHERE id NOT BETWEEN 1 AND 23'
  );
  const totalSignals = count('SELECT COUNT(*) AS row_count FROM demand_signals');
  const actionRows = queryRows(
    'SELECT action_type, status, COUNT(*) AS row_count FROM growth_actions GROUP BY action_type, status ORDER BY action_type, status'
  );

  const totalQualifiedLeadActions = actionRows
    .filter(row => String(row.action_type || '') === 'QUALIFIED_LEAD')
    .reduce((sum, row) => sum + safeCount(row), 0);
  const readyQualifiedLeadActions = actionRows
    .filter(row => String(row.action_type || '') === 'QUALIFIED_LEAD' && String(row.status || '') === 'READY')
    .reduce((sum, row) => sum + safeCount(row), 0);
  const statusTotal = statusRows.reduce((sum, row) => sum + safeCount(row), 0);

  renderLine('Demand signal status distribution (status=count):');
  for (const row of statusRows) renderLine(String(row.status || 'NULL') + '=' + safeCount(row));
  renderLine('Demand signal total=' + totalSignals);
  renderLine('Demand signal status-count sum=' + statusTotal);
  renderLine('Demand signal rows outside id range 1..23=' + outsideScope);
  renderLine('growth_actions aggregate counts (action_type/status=count):');
  for (const row of actionRows) {
    renderLine(String(row.action_type || 'NULL') + '/' + String(row.status || 'NULL') + '=' + safeCount(row));
  }
  renderLine('QUALIFIED_LEAD retained rows=' + totalQualifiedLeadActions);
  renderLine('QUALIFIED_LEAD READY rows=' + readyQualifiedLeadActions);

  if (statusTotal !== totalSignals) fail('Aggregate status counts do not match the demand_signals total.');
  if (outsideScope !== 0) fail('Unexpected demand_signals rows exist outside id range 1..23.');
  if (totalQualifiedLeadActions !== 23) fail('Expected all 23 historical QUALIFIED_LEAD actions to remain present.');
}

main().catch(error => {
  console.error(String(error?.message || 'Read-only D1 integrity audit failed.'));
  process.exit(1);
});
