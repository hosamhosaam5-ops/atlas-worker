import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const helper=readFileSync(new URL('../ops/scripts/d1-apply-0008.mjs',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../.github/workflows/d1-apply-0008.yml',import.meta.url),'utf8');
const trigger=readFileSync(new URL('../ops/triggers/apply-0008.trigger',import.meta.url),'utf8');

test('0008 runner pins the exact production database and same-run bookmark',()=>{
  assert.ok(helper.includes("const DATABASE_NAME='atlas_db'"));
  assert.ok(helper.includes("const DATABASE_ID='a5a75faa-e800-4112-b67a-3c53d7b0d8d4'"));
  assert.ok(helper.includes("const ACCOUNT_ID='c46718094ced1f5f75492f4c67c7d390'"));
  assert.ok(helper.includes('time_travel/bookmark'));
  assert.ok(helper.includes('GITHUB_RUN_ID'));
  assert.ok(helper.includes('2*60*60*1000'));
  assert.ok(helper.includes('PRAGMA table_info(demand_scan_source_runs)'));
  assert.ok(helper.includes('historical scan rows were backfilled or modified'));
  assert.ok(!helper.includes('migrations apply'));
  assert.ok(!helper.includes('d1_migrations'));
});

test('0008 workflow executes one exact allowlisted migration file only',()=>{
  assert.ok(workflow.includes("ALLOWED_SQL_FILE='migrations/0008_demand_scan_breaker_observability.sql'"));
  assert.ok(workflow.includes('wrangler d1 execute atlas_db --remote --file="$SQL_FILE"'));
  assert.ok(workflow.includes('d1-apply-0008.mjs guard'));
  assert.ok(workflow.includes('d1-apply-0008.mjs verify'));
  assert.ok(!workflow.includes('migrations apply'));
  assert.ok(!workflow.includes('d1_migrations'));
  assert.ok(trigger.includes('same-run Time Travel bookmark'));
});
