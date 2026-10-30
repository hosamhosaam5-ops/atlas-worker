import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('0007 workflow is fail-closed on PRs and executes only the explicit SQL allowlist', async () => {
  const workflow = await read('.github/workflows/d1-apply-0007.yml');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /validate-pr:\s*\n\s+if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /apply-0007:\s*\n\s+if: github\.event_name != 'pull_request'/);
  assert.match(workflow, /SQL_FILE='migrations\/0007_demand_query_indexes\.sql'/);
  assert.match(workflow, /ALLOWED_SQL_FILE='migrations\/0007_demand_query_indexes\.sql'/);
  assert.match(workflow, /wrangler d1 execute atlas_db --remote --file="\$SQL_FILE"/);
  assert.doesNotMatch(workflow, /wrangler d1 migrations apply/i);
  assert.match(workflow, /node --check ops\/scripts\/d1-apply-0007\.mjs/);
});

test('0007 migration contains exactly six additive CREATE INDEX IF NOT EXISTS statements', async () => {
  const sql = await read('migrations/0007_demand_query_indexes.sql');
  const executableSql = sql.replace(/^\s*--.*$/gm, '').trim();
  const statements = executableSql.split(';').map(value => value.trim()).filter(Boolean);
  assert.equal(statements.length, 6);
  for (const statement of statements) assert.match(statement, /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS /i);
  assert.doesNotMatch(executableSql, /\b(?:ALTER|DROP|DELETE|UPDATE|INSERT|REPLACE|CREATE TABLE)\b/i);
  for (const name of [
    'idx_capabilities_kind_status',
    'idx_reputation_identity',
    'idx_demand_status_score',
    'idx_growth_actions_status',
    'idx_engineering_jobs_status',
    'idx_demand_signal_key'
  ]) assert.equal(statements.filter(statement => statement.includes(name)).length, 1);
  assert.match(statements.find(statement => statement.includes('idx_demand_signal_key')), /^CREATE UNIQUE INDEX IF NOT EXISTS /i);
});

test('0007 helper waits for GITHUB_SHA and selects the latest completed post-deploy cycle', async () => {
  const helper = await read('ops/scripts/d1-apply-0007.mjs');
  const trigger = await read('ops/triggers/apply-0007.trigger');
  assert.match(helper, /env\\.GITHUB_SHA/);
  assert.match(helper, /ORDER BY started_at DESC LIMIT 1/);
  assert.match(helper, /attemptAgeMs>=30\\*60\\*1000/);
  assert.match(helper, /HAVING COUNT\\(\\*\\)=4/);
  assert.match(helper, /demand_signals must have exactly 10 columns/);
  assert.match(helper, /demand_signals rows; observed/);
  assert.match(helper, /nullKeys !== 0/);
  assert.match(helper, /duplicateGroups !== 0/);
  assert.match(helper, /age >= 2 \\* 60 \\* 60 \\* 1000/);
  assert.match(helper, /PRAGMA index_list/);
  assert.match(helper, /PRAGMA index_info/);
  assert.match(helper, /one or more table row counts changed during 0007/i);
  assert.doesNotMatch(helper, /readTrigger|EXPECTED_GROWTH_RUN_ID|EXPECTED_SCAN_ID/);
  assert.doesNotMatch(trigger, /EXPECTED_GROWTH_RUN_ID|EXPECTED_SCAN_ID|EXPECTED_WORKER_SHA/);
  assert.doesNotMatch(helper, /DROP INDEX|wrangler d1 migrations apply/i);
});

test('AgentJob gate allows exactly 60,000ms and is covered by persistent real SQLite tests', async () => {
  const engine = await read('src/autonomy/engine.js');
  const sqliteTest = await read('test/source-circuit-breaker.test.mjs');
  assert.match(engine, /new Date\\(now-AGENTJOB_LIST_POSTS_INTERVAL_MS\\)\\.toISOString\\(\\)/);
  assert.match(engine, /demand_source_health\\.last_attempt_at <= \\?/);
  assert.match(sqliteTest, /new DatabaseSync/);
  assert.match(sqliteTest, /\\[\\[0,false\\],\\[59999,false\\],\\[60000,true\\],\\[60001,true\\]\\]/);
  assert.match(sqliteTest, /DatabaseSync\\(filename\\)/);
  assert.match(sqliteTest, /Promise\\.all\\(\\[/);
  assert.match(sqliteTest, /mkdtempSync/);
  assert.match(sqliteTest, /rmSync/);
});
