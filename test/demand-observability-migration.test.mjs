import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('demand observability migration is additive and contains required measurement fields', async () => {
  const sql = await readFile(new URL('../migrations/0006_demand_observability.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE demand_signals ADD COLUMN source_url TEXT/i);
  assert.match(sql, /ALTER TABLE demand_signals ADD COLUMN last_verified_at TEXT/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS demand_scan_source_runs/i);
  assert.match(sql, /raw_recent_count INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /accepted_count INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /rejected_count INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /duplicate_count INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS demand_source_health/i);
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\s+demand_signals\b/i);
});
