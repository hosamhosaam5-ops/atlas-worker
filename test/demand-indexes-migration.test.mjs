import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

test('0007 demand indexes are correct, unique, idempotent, and rollback without changing rows', async () => {
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/d1-production-schema-2026-10-30.json', import.meta.url), 'utf8'));
  const migration0006 = await readFile(new URL('../migrations/0006_demand_observability.sql', import.meta.url), 'utf8');
  const migration0007 = await readFile(new URL('../migrations/0007_demand_query_indexes.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  const expected = [
    ['idx_capabilities_kind_status', 'capabilities', ['kind', 'status'], false],
    ['idx_reputation_identity', 'reputation_events', ['identity_id', 'created_at'], false],
    ['idx_demand_status_score', 'demand_signals', ['status', 'score'], false],
    ['idx_growth_actions_status', 'growth_actions', ['status', 'created_at'], false],
    ['idx_engineering_jobs_status', 'engineering_jobs', ['status', 'created_at'], false],
    ['idx_demand_signal_key', 'demand_signals', ['signal_key'], true]
  ];
  const quote = (value) => '"' + String(value).replaceAll('"', '""') + '"';
  const tableCounts = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, Number(db.prepare('SELECT COUNT(*) AS n FROM ' + quote(name)).get().n)]));
  const indexList = (table) => db.prepare('PRAGMA index_list(' + quote(table) + ')').all();

  try {
    for (const object of snapshot.objects.filter((item) => item.type === 'table')) db.exec(object.sql);
    for (const object of snapshot.objects.filter((item) => item.type === 'index')) db.exec(object.sql);

    const seed = db.prepare(`INSERT INTO demand_signals
      (id, source, signal_key, request_summary, score, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let id = 1; id <= 23; id++) {
      seed.run(id, 'opentask_public_tasks', 'fixture-signal-' + id, 'fixture row ' + id, 0.5,
        'STALE_UNVERIFIED', '2026-10-01 00:00:00', null);
    }
    db.exec(migration0006);

    const before = tableCounts();
    const nulls = Number(db.prepare('SELECT COUNT(*) AS n FROM demand_signals WHERE signal_key IS NULL').get().n);
    const duplicates = Number(db.prepare('SELECT COUNT(*) AS n FROM (SELECT signal_key FROM demand_signals GROUP BY signal_key HAVING COUNT(*) > 1)').get().n);
    assert.equal(nulls, 0);
    assert.equal(duplicates, 0);

    db.exec(migration0007);
    db.exec(migration0007);
    for (const [name, table, columns, unique] of expected) {
      const index = indexList(table).find((item) => item.name === name);
      assert.ok(index, 'missing ' + name);
      assert.equal(Number(index.unique), Number(unique));
      const actualColumns = db.prepare('PRAGMA index_info(' + quote(name) + ')').all()
        .sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((row) => row.name);
      assert.deepEqual(actualColumns, columns);
    }

    const duplicateKey = db.prepare('SELECT signal_key FROM demand_signals ORDER BY id LIMIT 1').get().signal_key;
    assert.throws(() => db.prepare('INSERT INTO demand_signals(source, signal_key) VALUES (?, ?)').run('duplicate-probe', duplicateKey),
      /UNIQUE constraint failed: demand_signals\.signal_key/i);
    assert.deepEqual(tableCounts(), before);

    for (const [name] of expected) db.exec('DROP INDEX IF EXISTS ' + quote(name));
    for (const [name, table] of expected) assert.ok(!indexList(table).some((item) => item.name === name));
    assert.deepEqual(tableCounts(), before);
  } finally {
    db.close();
  }
});
