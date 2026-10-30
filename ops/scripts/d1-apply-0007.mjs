import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

const mode = process.argv[2];
const env = process.env;
const summary = env.GITHUB_STEP_SUMMARY;
const output = env.GITHUB_OUTPUT;
const ACCOUNT_ID = 'c46718094ced1f5f75492f4c67c7d390';
const DATABASE_NAME = 'atlas_db';
const DATABASE_ID = 'a5a75faa-e800-4112-b67a-3c53d7b0d8d4';
const TRIGGER_PATH = 'ops/triggers/apply-0007.trigger';
const BASELINE_PATH = '.d1-0007-preflight.json';
const HEALTH_URL = 'https://atlas-worker.hosamhosaam5.workers.dev/health';
const EXPECTED_INDEXES = [
  { name: 'idx_capabilities_kind_status', table: 'capabilities', columns: ['kind', 'status'], unique: false },
  { name: 'idx_reputation_identity', table: 'reputation_events', columns: ['identity_id', 'created_at'], unique: false },
  { name: 'idx_demand_status_score', table: 'demand_signals', columns: ['status', 'score'], unique: false },
  { name: 'idx_growth_actions_status', table: 'growth_actions', columns: ['status', 'created_at'], unique: false },
  { name: 'idx_engineering_jobs_status', table: 'engineering_jobs', columns: ['status', 'created_at'], unique: false },
  { name: 'idx_demand_signal_key', table: 'demand_signals', columns: ['signal_key'], unique: true }
];
const MAIN_TABLES_TO_REPORT = [
  'event_log', 'order_quotes', 'order_ledger', 'execution_state',
  'ceo_memory', 'bridge_audit', 'order_files', 'delivery_outbox',
  'demand_signals', 'demand_scan_source_runs', 'demand_source_health'
];

function fail(message) { throw new Error(message); }

function runWrangler(args) {
  const result = spawnSync('npx', ['--no-install', 'wrangler', ...args], {
    encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || 'Wrangler command failed')
      .trim().replace(/[a-f0-9]{32}/gi, '[redacted]');
    fail('Wrangler command failed: ' + detail);
  }
  return String(result.stdout || '').trim();
}

function parseJson(text) {
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0).sort((a,b)=>a-b);
  for (const start of starts) {
    const closing = text[start] === '{' ? text.lastIndexOf('}') : text.lastIndexOf(']');
    if (closing < start) continue;
    try { return JSON.parse(text.slice(start, closing + 1)); } catch {}
  }
  fail('No complete JSON payload returned by Wrangler.');
}

function findResultRows(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) findResultRows(item, found);
  } else if (value && typeof value === 'object') {
    if (Array.isArray(value.results)) found.push(value.results);
    for (const [key, item] of Object.entries(value)) {
      if (key !== 'results') findResultRows(item, found);
    }
  }
  return found;
}

function queryRows(sql) {
  const raw = runWrangler(['d1', 'execute', DATABASE_NAME, '--remote', '--command', sql, '--json']);
  const parsed = parseJson(raw);
  const candidates = findResultRows(parsed);
  if (!candidates.length) fail('D1 query returned no result-set envelope.');
  return candidates[0];
}

function quoteIdentifier(value) {
  return '"' + String(value).replaceAll('"', '""') + '"';
}

function readTrigger() {
  const source = readFileSync(TRIGGER_PATH, 'utf8');
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  for (const required of ['EXPECTED_WORKER_SHA', 'EXPECTED_GROWTH_RUN_ID', 'EXPECTED_SCAN_ID']) {
    if (!values[required]) fail('Missing ' + required + ' in allowlisted trigger file.');
  }
  if (!/^[a-f0-9]{40}$/i.test(values.EXPECTED_WORKER_SHA)) fail('Invalid expected Worker SHA in trigger file.');
  return values;
}

async function resolveD1() {
  if (!env.CLOUDFLARE_API_TOKEN) fail('Missing CLOUDFLARE_API_TOKEN; refusing D1 operation.');
  const identityResult = spawnSync('npx', ['--no-install', 'wrangler', 'whoami', '--json'], {
    encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024
  });
  if (identityResult.status !== 0) fail('Wrangler account identity lookup failed; refusing D1 operation.');
  const identity = parseJson(String(identityResult.stdout || '').trim());
  const accounts = Array.isArray(identity.accounts) ? identity.accounts : (Array.isArray(identity.result?.accounts) ? identity.result.accounts : []);
  if (accounts.length !== 1) fail('Expected exactly one Wrangler account; refusing ambiguous D1 selection.');
  const accountId = String(accounts[0]?.id || '');
  if (accountId !== ACCOUNT_ID) fail('Wrangler account does not match the allowlisted ATLAS account.');

  const api = async (path) => {
    const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
      headers: { Authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN, 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    if (!response.ok || data.success !== true) {
      const messages = Array.isArray(data.errors) ? data.errors.map(x => x.message).join('; ') : '';
      fail('Cloudflare D1 API HTTP ' + response.status + (messages ? ': ' + messages : ''));
    }
    return data.result;
  };

  const listed = await api('/accounts/' + ACCOUNT_ID + '/d1/database?name=' + encodeURIComponent(DATABASE_NAME) + '&per_page=100');
  const matches = Array.isArray(listed) ? listed.filter(x => x.name === DATABASE_NAME && x.uuid === DATABASE_ID) : [];
  if (matches.length !== 1) fail('Exact allowlisted D1 database was not returned; refusing operation.');
  const details = await api('/accounts/' + ACCOUNT_ID + '/d1/database/' + DATABASE_ID + '?fields=uuid,name,version');
  if (details?.uuid !== DATABASE_ID || details?.name !== DATABASE_NAME || details?.version !== 'production') {
    fail('D1 identity/version mismatch; only the exact production atlas_db is permitted.');
  }
  return { api };
}

async function readProductionHealth(expectedSha) {
  const response = await fetch(HEALTH_URL, { headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  if (response.status !== 200) fail('Production /health returned HTTP ' + response.status + '.');
  const body = await response.json();
  if (body?.ok !== true || body?.db !== 'ok' || body?.git_sha !== expectedSha) {
    fail('Production /health did not match the expected healthy Worker SHA.');
  }
  return body;
}

async function verifyDeploymentCycle(trigger, expectedSha) {
  await readProductionHealth(expectedSha);
  const runs = queryRows(
    "SELECT run_id,status,started_at,finished_at FROM growth_runs WHERE run_id='" +
    trigger.EXPECTED_GROWTH_RUN_ID.replaceAll("'", "''") + "'"
  );
  if (runs.length !== 1 || runs[0].status !== 'COMPLETED') {
    fail('Expected post-deploy growth cycle is missing or not COMPLETED.');
  }
  const scans = queryRows(
    "SELECT scan_id,source,http_status,source_status,error_code,started_at,finished_at " +
    "FROM demand_scan_source_runs WHERE scan_id='" + trigger.EXPECTED_SCAN_ID.replaceAll("'", "''") + "' ORDER BY source"
  );
  const expectedSources = ['agent_job_public_mcp','agent_souk','opentask_public_tasks','payanagent_open_requests'];
  if (scans.length !== 4 || scans.some(row => row.scan_id !== trigger.EXPECTED_SCAN_ID) ||
      expectedSources.some(source => !scans.some(row => row.source === source))) {
    fail('Expected four source scan rows for the recorded post-deploy scan were not found.');
  }
  for (const source of ['agent_job_public_mcp','opentask_public_tasks','agent_souk']) {
    const row = scans.find(item => item.source === source);
    if (Number(row.http_status) !== 200 || row.source_status !== 'OK') {
      fail('A required healthy source is not OK in the recorded post-deploy scan: ' + source);
    }
  }
  const healthRows = queryRows(
    "SELECT source,updated_at,last_attempt_at FROM demand_source_health WHERE source IN " +
    "('agent_job_public_mcp','agent_souk','opentask_public_tasks','payanagent_open_requests')"
  );
  if (healthRows.length !== 4) fail('Four corresponding demand_source_health rows are not present.');
  const healthUpdatedTimes = healthRows.map(row => Date.parse(row.updated_at || ''));
  const cycleStarted = Date.parse(String(runs[0].started_at).replace(' ', 'T') + 'Z');
  if (healthUpdatedTimes.some(value => !Number.isFinite(value)) || !Number.isFinite(cycleStarted) ||
      Math.min(...healthUpdatedTimes) < cycleStarted - 60000) {
    fail('Source health rows do not correspond in time with the expected completed growth cycle.');
  }
  const agentJobHealth = healthRows.find(row => row.source === 'agent_job_public_mcp');
  const agentJobAttempt = Date.parse(agentJobHealth?.last_attempt_at || '');
  const agentJobScan = scans.find(row => row.source === 'agent_job_public_mcp');
  const agentJobScanStarted = Date.parse(agentJobScan?.started_at || '');
  const agentJobScanFinished = Date.parse(agentJobScan?.finished_at || '');
  if (!Number.isFinite(agentJobAttempt) || !Number.isFinite(agentJobScanStarted) ||
      !Number.isFinite(agentJobScanFinished) || agentJobAttempt < cycleStarted - 5000 ||
      agentJobAttempt > agentJobScanStarted + 30000 || agentJobAttempt > agentJobScanFinished) {
    fail('The production AgentJob last_attempt_at was not persisted for the expected growth cycle.');
  }
  return { run: runs[0], scans, healthRows };
}

async function capture() {
  const { api } = await resolveD1();
  const result = await api('/accounts/' + ACCOUNT_ID + '/d1/database/' + DATABASE_ID + '/time_travel/bookmark');
  const bookmark = String(result?.bookmark || '');
  if (!bookmark) fail('Cloudflare returned no D1 bookmark; refusing write workflow.');
  const capturedAtMs = Date.now();
  const runId = String(env.GITHUB_RUN_ID || '');
  if (!runId) fail('GITHUB_RUN_ID is missing; refusing D1 write workflow.');
  if (!/^[a-f0-9-]{24,128}$/i.test(bookmark)) fail('Bookmark format invalid; refusing D1 write.');
  appendFileSync(output, 'd1_bookmark=' + bookmark + '\n');
  appendFileSync(output, 'd1_bookmark_captured_at_ms=' + capturedAtMs + '\n');
  appendFileSync(output, 'd1_bookmark_run_id=' + runId + '\n');
  appendFileSync(summary, '## 0007 pre-write D1 bookmark\n\n- Bookmark: `' + bookmark + '`\n- Captured in workflow run: **' + runId + '**\n- Captured at UTC: **' + new Date(capturedAtMs).toISOString() + '**\n');
}

function guard() {
  const bookmark = String(env.D1_BOOKMARK || '');
  const capturedAt = Number(env.D1_BOOKMARK_CAPTURED_AT_MS || 0);
  const capturedRun = String(env.D1_BOOKMARK_RUN_ID || '');
  const currentRun = String(env.GITHUB_RUN_ID || '');
  if (!bookmark || !capturedAt || !capturedRun || capturedRun !== currentRun) fail('No bookmark captured in this exact workflow run.');
  if (!/^[a-f0-9-]{24,128}$/i.test(bookmark)) fail('Bookmark format invalid.');
  const age = Date.now() - capturedAt;
  if (age < 0 || age >= 2 * 60 * 60 * 1000) fail('Bookmark is not younger than two hours; refusing D1 write.');
  appendFileSync(summary, '- Same-run bookmark age: **' + Math.floor(age / 1000) + ' seconds — PASS**\n');
}

function getIndexDefinitions(tableNames) {
  const indexes = [];
  for (const table of tableNames) {
    const list = queryRows('PRAGMA index_list(' + quoteIdentifier(table) + ')');
    for (const item of list) {
      const columns = queryRows('PRAGMA index_info(' + quoteIdentifier(item.name) + ')')
        .sort((a,b) => Number(a.seqno) - Number(b.seqno)).map(row => String(row.name));
      indexes.push({
        name: String(item.name), table,
        columns, unique: Number(item.unique) === 1,
        partial: Number(item.partial || 0) === 1
      });
    }
  }
  return indexes;
}

function currentTableNames() {
  return queryRows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map(row => String(row.name));
}

function readAllTableCounts(tables) {
  const result = {};
  for (const table of tables) {
    const rows = queryRows('SELECT COUNT(*) AS row_count FROM ' + quoteIdentifier(table));
    if (rows.length !== 1) fail('Could not read row count for table ' + table + '.');
    result[table] = Number(rows[0].row_count);
    if (!Number.isSafeInteger(result[table]) || result[table] < 0) fail('Invalid row count for table ' + table + '.');
  }
  return result;
}

async function preflight() {
  const trigger = readTrigger();
  await resolveD1();
  await verifyDeploymentCycle(trigger, trigger.EXPECTED_WORKER_SHA);

  const demandColumns = queryRows('PRAGMA table_info(demand_signals)').map(row => String(row.name));
  if (demandColumns.length !== 10 ||
      !demandColumns.includes('source_url') || !demandColumns.includes('last_verified_at')) {
    fail('Preflight mismatch: demand_signals must have exactly 10 columns including source_url and last_verified_at.');
  }

  const demandCountRows = queryRows('SELECT COUNT(*) AS row_count FROM demand_signals');
  const demandRows = Number(demandCountRows[0]?.row_count);
  if (demandRows !== 23) fail('Preflight mismatch: expected 23 demand_signals rows; observed ' + demandRows + '.');

  const keyState = queryRows(
    "SELECT COUNT(*) AS total_rows, " +
    "SUM(CASE WHEN signal_key IS NULL THEN 1 ELSE 0 END) AS null_keys, " +
    "COUNT(DISTINCT signal_key) AS distinct_keys FROM demand_signals"
  );
  const nullKeys = Number(keyState[0]?.null_keys || 0);
  const totalRows = Number(keyState[0]?.total_rows || 0);
  const distinctKeys = Number(keyState[0]?.distinct_keys || 0);
  const duplicateGroupsRows = queryRows(
    "SELECT COUNT(*) AS duplicate_groups FROM (" +
    "SELECT signal_key FROM demand_signals GROUP BY signal_key HAVING COUNT(*) > 1)"
  );
  const duplicateGroups = Number(duplicateGroupsRows[0]?.duplicate_groups || 0);
  if (nullKeys !== 0 || duplicateGroups !== 0 || distinctKeys !== totalRows) {
    fail('Preflight failed: signal_key NULL or duplicate-key counts are non-zero.');
  }

  const tables = currentTableNames();
  const definitions = getIndexDefinitions(tables);
  const schemaObjects = queryRows(
    "SELECT name,tbl_name FROM sqlite_master WHERE type='index' AND name IN (" +
    EXPECTED_INDEXES.map(item => "'" + item.name.replaceAll("'", "''") + "'").join(',') + ')'
  );
  if (schemaObjects.length !== 0) fail('One or more allowlisted index names already exist; refusing to apply 0007.');

  for (const expected of EXPECTED_INDEXES) {
    const equivalent = definitions.find(index =>
      index.table === expected.table &&
      index.unique === expected.unique &&
      index.partial === false &&
      JSON.stringify(index.columns) === JSON.stringify(expected.columns)
    );
    if (equivalent) fail('Equivalent index already exists under another name for ' + expected.name + '.');
  }

  const counts = readAllTableCounts(tables);
  const baseline = {
    database_id: DATABASE_ID,
    expected_worker_sha: trigger.EXPECTED_WORKER_SHA,
    growth_run_id: trigger.EXPECTED_GROWTH_RUN_ID,
    scan_id: trigger.EXPECTED_SCAN_ID,
    tables,
    counts,
    demand_signals_rows: demandRows,
    demand_signals_columns: demandColumns.length,
    signal_key_nulls: nullKeys,
    signal_key_duplicate_groups: duplicateGroups,
    preflight_at: new Date().toISOString()
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline), { mode: 0o600 });
  chmodSync(BASELINE_PATH, 0o600);

  appendFileSync(summary, '\n## 0007 read-only preflight — PASS\n\n');
  appendFileSync(summary, '- Production D1: **' + DATABASE_NAME + '**\n');
  appendFileSync(summary, '- Production Worker SHA: **' + trigger.EXPECTED_WORKER_SHA + '**\n');
  appendFileSync(summary, '- Growth run: **' + trigger.EXPECTED_GROWTH_RUN_ID + '** — COMPLETED\n');
  appendFileSync(summary, '- Scan ID: **' + trigger.EXPECTED_SCAN_ID + '** — 4 source rows\n');
  appendFileSync(summary, '- demand_signals columns: **' + demandColumns.length + '**\n');
  appendFileSync(summary, '- demand_signals rows: **' + demandRows + '**\n');
  appendFileSync(summary, '- signal_key NULL values: **0**\n');
  appendFileSync(summary, '- signal_key duplicate groups: **0**\n');
  appendFileSync(summary, '- All six target indexes absent; no equivalent indexes found: **PASS**\n');
  appendFileSync(summary, '- Baseline row counts for ' + tables.length + ' tables captured locally; only main-table counts are listed below.\n');
  for (const table of MAIN_TABLES_TO_REPORT) {
    if (Object.hasOwn(counts, table)) appendFileSync(summary, '- ' + table + ' rows: **' + counts[table] + '**\n');
  }
  appendFileSync(summary, '- AgentJob gate last_attempt_at is populated in the verified post-deploy cycle.\n');
  return true;
}

async function verify() {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const trigger = readTrigger();
  await resolveD1();
  await readProductionHealth(trigger.EXPECTED_WORKER_SHA);

  const tables = currentTableNames();
  if (JSON.stringify(tables) !== JSON.stringify(baseline.tables)) fail('Postflight mismatch: table set changed during 0007.');
  const afterCounts = readAllTableCounts(tables);
  if (JSON.stringify(afterCounts) !== JSON.stringify(baseline.counts)) {
    fail('Postflight mismatch: one or more table row counts changed during 0007.');
  }

  const definitions = getIndexDefinitions(tables);
  for (const expected of EXPECTED_INDEXES) {
    const matches = definitions.filter(index => index.name === expected.name && index.table === expected.table);
    if (matches.length !== 1) fail('Postflight mismatch: missing or duplicate index ' + expected.name + '.');
    const actual = matches[0];
    if (actual.unique !== expected.unique || actual.partial ||
        JSON.stringify(actual.columns) !== JSON.stringify(expected.columns)) {
      fail('Postflight mismatch: index definition differs for ' + expected.name + '.');
    }
  }

  const demandColumns = queryRows('PRAGMA table_info(demand_signals)').map(row => String(row.name));
  if (demandColumns.length !== baseline.demand_signals_columns) fail('Postflight mismatch: demand_signals column count changed.');
  const keyState = queryRows(
    "SELECT COUNT(*) AS total_rows, " +
    "SUM(CASE WHEN signal_key IS NULL THEN 1 ELSE 0 END) AS null_keys, " +
    "COUNT(DISTINCT signal_key) AS distinct_keys FROM demand_signals"
  );
  const duplicateGroupsRows = queryRows(
    "SELECT COUNT(*) AS duplicate_groups FROM (" +
    "SELECT signal_key FROM demand_signals GROUP BY signal_key HAVING COUNT(*) > 1)"
  );
  if (Number(keyState[0]?.null_keys || 0) !== 0 ||
      Number(duplicateGroupsRows[0]?.duplicate_groups || 0) !== 0 ||
      Number(keyState[0]?.distinct_keys || 0) !== Number(keyState[0]?.total_rows || 0)) {
    fail('Postflight mismatch: signal_key integrity checks failed.');
  }

  appendFileSync(summary, '\n## 0007 postflight — PASS\n\n');
  for (const expected of EXPECTED_INDEXES) {
    appendFileSync(summary, '- ' + expected.name + ': **PASS** (' + expected.columns.join(',') + '; unique=' + Number(expected.unique) + ')\n');
  }
  appendFileSync(summary, '- All table row counts unchanged: **PASS**\n');
  appendFileSync(summary, '- demand_signals columns unchanged at **' + demandColumns.length + '**; rows **' + Number(keyState[0].total_rows) + '**\n');
  appendFileSync(summary, '- signal_key NULL values: **0**; duplicate groups: **0**\n');
  for (const table of MAIN_TABLES_TO_REPORT) {
    if (Object.hasOwn(afterCounts, table)) appendFileSync(summary, '- ' + table + ' rows: **' + afterCounts[table] + '**\n');
  }
  appendFileSync(summary, '- Production /health HTTP 200; ok=true; db=ok; git_sha matches expected: **PASS**\n');
  appendFileSync(summary, '- No migrations apply command or d1_migrations write was executed.\n');
}

try {
  if (mode === 'capture') await capture();
  else if (mode === 'guard') guard();
  else if (mode === 'preflight') await preflight();
  else if (mode === 'verify') await verify();
  else fail('Unknown mode. Use capture, guard, preflight, or verify.');
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(1);
}
