import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const snapshotPath = process.argv[2];
if (!snapshotPath) throw new Error('Usage: node ops/scripts/test-0007-demand-indexes.mjs <production-export.sql>');

const snapshotSql = await readFile(snapshotPath, 'utf8');
const migrationSql = await readFile(new URL('../../migrations/0007_demand_query_indexes.sql', import.meta.url), 'utf8');
const db = new DatabaseSync(':memory:');

const expected = [
  { name: 'idx_capabilities_kind_status', table: 'capabilities', columns: ['kind', 'status'], unique: false },
  { name: 'idx_reputation_identity', table: 'reputation_events', columns: ['identity_id', 'created_at'], unique: false },
  { name: 'idx_demand_status_score', table: 'demand_signals', columns: ['status', 'score'], unique: false },
  { name: 'idx_growth_actions_status', table: 'growth_actions', columns: ['status', 'created_at'], unique: false },
  { name: 'idx_engineering_jobs_status', table: 'engineering_jobs', columns: ['status', 'created_at'], unique: false },
  { name: 'idx_demand_signal_key', table: 'demand_signals', columns: ['signal_key'], unique: true }
];

const quote = (value) => '"' + String(value).replaceAll('"', '""') + '"';
const tableNames = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
const counts = () => Object.fromEntries(tableNames().map((name) => [name, Number(db.prepare('SELECT COUNT(*) AS n FROM ' + quote(name)).get().n)]));
const indexes = () => {
  const found = [];
  for (const table of tableNames()) {
    for (const index of db.prepare('PRAGMA index_list(' + quote(table) + ')').all()) {
      const columns = db.prepare('PRAGMA index_info(' + quote(index.name) + ')').all()
        .sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((row) => row.name);
      found.push({ name: index.name, table, columns, unique: Number(index.unique) === 1 });
    }
  }
  return found;
};
const verifyIndexes = () => {
  const all = indexes();
  for (const item of expected) {
    const actual = all.find((index) => index.name === item.name && index.table === item.table);
    assert.ok(actual, 'missing index ' + item.name);
    assert.equal(actual.unique, item.unique, 'wrong unique flag for ' + item.name);
    assert.deepEqual(actual.columns, item.columns, 'wrong columns for ' + item.name);
  }
};

try {
  db.exec(snapshotSql);
  const tables = tableNames();
  for (const item of expected) assert.ok(tables.includes(item.table), 'production export is missing table ' + item.table);

  const preflight = db.prepare(`
    SELECT COUNT(*) AS total_rows,
      SUM(CASE WHEN signal_key IS NULL THEN 1 ELSE 0 END) AS null_signal_keys
    FROM demand_signals
  `).get();
  const duplicateGroups = Number(db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT signal_key FROM demand_signals GROUP BY signal_key HAVING COUNT(*) > 1
    )
  `).get().n);
  assert.equal(Number(preflight.null_signal_keys || 0), 0, 'NULL signal_key values must be zero before migration');
  assert.equal(duplicateGroups, 0, 'duplicate signal_key groups must be zero before migration');

  const currentIndexes = indexes();
  for (const item of expected) {
    assert.ok(!currentIndexes.some((index) => index.name === item.name), 'expected index already exists: ' + item.name);
    const equivalent = currentIndexes.find((index) =>
      index.table === item.table && index.unique === item.unique &&
      JSON.stringify(index.columns) === JSON.stringify(item.columns));
    assert.ok(!equivalent, 'equivalent index already exists under another name: ' + item.name);
  }

  const before = counts();
  const demandRowsBefore = Number(preflight.total_rows);
  assert.ok(demandRowsBefore > 0, 'production demand_signals snapshot is unexpectedly empty');

  db.exec(migrationSql);
  verifyIndexes();
  db.exec(migrationSql);
  verifyIndexes();

  const existing = db.prepare('SELECT signal_key FROM demand_signals ORDER BY id LIMIT 1').get();
  assert.ok(existing?.signal_key, 'no existing signal_key available for uniqueness probe');
  let duplicateRejected = false;
  try {
    db.prepare('INSERT INTO demand_signals(source, signal_key) VALUES (?, ?)').run('snapshot-unique-probe', existing.signal_key);
  } catch (error) {
    if (/UNIQUE constraint failed: demand_signals\.signal_key/i.test(String(error?.message || error))) duplicateRejected = true;
    else throw error;
  }
  assert.equal(duplicateRejected, true, 'duplicate signal_key insert was not rejected by the unique index');

  const after = counts();
  assert.deepEqual(after, before, 'table row counts changed during migration or duplicate probe');

  for (const item of expected) db.exec('DROP INDEX IF EXISTS ' + quote(item.name));
  const remaining = indexes();
  for (const item of expected) assert.ok(!remaining.some((index) => index.name === item.name), 'rollback left index ' + item.name);
  assert.deepEqual(counts(), before, 'rollback changed table row counts');

  console.log('snapshot_source=full production D1 export (ephemeral; not uploaded)');
  console.log('production_tables=' + tables.length);
  console.log('demand_signals_rows=' + demandRowsBefore);
  console.log('signal_key_nulls=' + Number(preflight.null_signal_keys || 0));
  console.log('signal_key_duplicate_groups=' + duplicateGroups);
  for (const item of expected) console.log('index=' + item.name + ' unique=' + Number(item.unique) + ' columns=' + item.columns.join(','));
  console.log('migration_apply_twice=PASS');
  console.log('duplicate_signal_key_insert_rejected=PASS');
  console.log('all_table_row_counts_unchanged=PASS');
  console.log('rollback_drop_indexes_only=PASS');
} finally {
  db.close();
}
