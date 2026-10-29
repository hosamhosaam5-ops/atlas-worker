import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

(async () => {
const summary = process.env.GITHUB_STEP_SUMMARY;
const env = process.env;
const run = (args) => {
  const r = spawnSync('npx', ['--no-install', 'wrangler', ...args], {
    encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(String(r.stderr || r.stdout || r.error?.message || 'Wrangler command failed').trim());
  return String(r.stdout || '').trim();
};
const fail = (label, message) => {
  fs.appendFileSync(summary, '## D1 restore-point capture: FAILED\n\n- ' + label + ': **FAILED**\n\n```text\n' + message + '\n```\n');
  process.exit(31);
};
const timestamp = new Date().toISOString();
let bookmark = '';
try {
  const token = env.CLOUDFLARE_API_TOKEN;
const whoami = spawnSync('npx', ['--no-install', 'wrangler', 'whoami', '--json'], {
  encoding: 'utf8', env: env, maxBuffer: 8 * 1024 * 1024,
});
if (whoami.status !== 0) throw new Error('Wrangler account identity lookup failed; refusing ambiguous account selection.');
const identityText = String(whoami.stdout || '').trim();
const jsonStart = identityText.indexOf('{');
if (jsonStart < 0) throw new Error('Wrangler returned no account identity JSON.');
const identity = JSON.parse(identityText.slice(jsonStart));
const accounts = Array.isArray(identity.accounts) ? identity.accounts : (Array.isArray(identity.result?.accounts) ? identity.result.accounts : []);
if (accounts.length !== 1) throw new Error('Expected exactly one accessible Cloudflare account; refusing ambiguous account selection.');
const account = String(accounts[0]?.id || '');
if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error('Wrangler returned no valid account identifier.');
  const api = async (path) => {
    const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    if (!response.ok || data.success !== true) {
      const details = Array.isArray(data.errors) ? data.errors.map(x => x.message).join('; ') : '';
      throw new Error('Cloudflare API HTTP ' + response.status + (details ? ': ' + details : ''));
    }
    return data.result;
  };
  const listed = await api('/accounts/' + account + '/d1/database?name=atlas_db&per_page=100');
  const db = Array.isArray(listed) ? listed.find(x => x.name === 'atlas_db') : null;
  if (!db?.uuid) throw new Error('Exact database atlas_db was not returned by the D1 list endpoint.');
  const point = await api('/accounts/' + account + '/d1/database/' + db.uuid + '/time_travel/bookmark');
  bookmark = point?.bookmark || '';
} catch (e) { fail('Time Travel bookmark', String(e.message || e)); }
if (!bookmark) fail('Time Travel bookmark', 'Cloudflare returned no bookmark value.');
const mainTables = [
  'event_log','order_quotes','order_ledger','execution_state','ceo_memory',
  'bridge_audit','zatca_experiment_requests','acquisition_assets','channel_watch',
  'publications','bountybook_auth_nonces','order_files','delivery_outbox',
  'demand_signals','demand_scan_source_runs','demand_source_health'
];
const rowsFrom = (value, arrays = []) => {
  if (Array.isArray(value)) {
    if (value.length && value.every(x => x && typeof x === 'object' && !Array.isArray(x) && !('results' in x))) arrays.push(value);
    for (const x of value) rowsFrom(x, arrays);
  } else if (value && typeof value === 'object') {
    for (const x of Object.values(value)) rowsFrom(x, arrays);
  }
  return arrays;
};
const queryRows = (sql) => {
  const raw = run(['d1','execute','atlas_db','--remote','--command',sql,'--json']);
  const parsed = JSON.parse(raw);
  const arrays = rowsFrom(parsed);
  return arrays.sort((a,b) => b.length-a.length)[0] || [];
};
let columns;
try { columns = queryRows('PRAGMA table_info(demand_signals)').length; }
catch (e) { fail('demand_signals schema inspection', String(e.message || e)); }
let demandCount;
try {
  const rows = queryRows('SELECT COUNT(*) AS row_count FROM demand_signals');
  demandCount = Number(rows[0]?.row_count);
} catch (e) { fail('demand_signals count', String(e.message || e)); }
if (!Number.isFinite(demandCount)) fail('demand_signals count', 'Wrangler returned no numeric row_count.');
const counts = [];
for (const table of mainTables) {
  try {
    const rows = queryRows('SELECT COUNT(*) AS row_count FROM "' + table + '"');
    const count = Number(rows[0]?.row_count);
    counts.push([table, Number.isFinite(count) ? String(count) : 'UNREADABLE']);
  } catch {
    counts.push([table, 'MISSING_OR_UNREADABLE']);
  }
}
if (columns !== 8) fail('demand_signals column count', 'Expected 8 columns; observed ' + columns + '.');
if (demandCount !== 23) fail('demand_signals row count', 'Expected 23 rows; observed ' + demandCount + '.');
const lines = [
  '## D1 Time Travel restore point',
  '',
  '- Bookmark: `' + bookmark + '`',
  '- demand_signals columns: **' + columns + ' / 8**',
  '- demand_signals rows: **' + demandCount + ' / 23**',
  '',
  '### Main-table row counts',
  ...counts.map(([name,count]) => '- ' + name + ': **' + count + '**'),
  '',
  '- Restore operation performed: **NO**',
  '- Database writes performed: **NO**',
];
fs.appendFileSync(summary, lines.join('\n') + '\n');
})().catch((error) => { console.error(error); process.exit(1); });