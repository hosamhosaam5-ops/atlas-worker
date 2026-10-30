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
  const executableSql = sql.replace(/^\\s*--.*$/gm, '').trim();
  const statements = executableSql.split(';').map(value => value.trim()).filter(Boolean);
  assert.equal(statements.length, 6);
  for (const statement of statements) assert.match(statement, /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS /i);
  assert.doesNotMatch(sql, /\b(?:ALTER|DROP|DELETE|UPDATE|INSERT|REPLACE|CREATE TABLE)\b/i);
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

test('0007 helper pins the exact production database and verifies bookmark, index definitions and row counts', async () => {
  const helper = await read('ops/scripts/d1-apply-0007.mjs');
  assert.match(helper, /const ACCOUNT_ID = 'c46718094ced1f5f75492f4c67c7d390'/);
  assert.match(helper, /const DATABASE_ID = 'a5a75faa-e800-4112-b67a-3c53d7b0d8d4'/);
  assert.match(helper, /details\?\.version !== 'production'/);
  assert.match(helper, /age >= 2 \* 60 \* 60 \* 1000/);
  assert.match(helper, /PRAGMA index_list/);
  assert.match(helper, /PRAGMA index_info/);
  assert.match(helper, /one or more table row counts changed during 0007/i);
  assert.match(helper, /last_attempt_at was not persisted/i);
  assert.doesNotMatch(helper, /DROP INDEX|wrangler d1 migrations apply/i);
});
