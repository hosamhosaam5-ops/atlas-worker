import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

test('0006 applies to exported production schema and safely rejects a second application', async () => {
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/d1-production-schema-2026-10-30.json', import.meta.url), 'utf8'));
  const migration = await readFile(new URL('../migrations/0006_demand_observability.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    // Rebuild the captured production schema locally; tables before indexes.
    for (const object of snapshot.objects.filter((x) => x.type === 'table')) db.exec(object.sql);
    for (const object of snapshot.objects.filter((x) => x.type === 'index')) db.exec(object.sql);

    const seed = db.prepare(`INSERT INTO demand_signals
      (id, source, signal_key, request_summary, score, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let id = 1; id <= 23; id++) {
      seed.run(id, 'opentask_public_tasks', `production-fixture-${id}`, `fixture row ${id}`, 0.5,
        'QUALIFIED', '2026-10-01 00:00:00', null);
    }
    const before = db.prepare('SELECT id, source, signal_key, request_summary, score, status, created_at, updated_at FROM demand_signals ORDER BY id').all();

    db.exec(migration);
    const columns = db.prepare('PRAGMA table_info(demand_signals)').all().map((row) => row.name);
    assert.equal(columns.length, 10);
    assert.deepEqual(columns.slice(-2), ['source_url', 'last_verified_at']);
    assert.deepEqual(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
      AND name IN ('demand_scan_source_runs','demand_source_health') ORDER BY name`).all().map((row) => row.name),
      ['demand_scan_source_runs', 'demand_source_health']);

    const after = db.prepare('SELECT id, source, signal_key, request_summary, score, status, created_at, updated_at FROM demand_signals ORDER BY id').all();
    assert.equal(after.length, 23);
    assert.deepEqual(after, before);
    assert.equal(db.prepare("SELECT count(*) AS n FROM demand_signals WHERE status='QUALIFIED' AND source='opentask_public_tasks'").get().n, 23);

    assert.throws(() => db.exec(migration), /duplicate column name: source_url/i,
      'second application must fail clearly at the non-idempotent ALTER TABLE, not silently corrupt schema');
    assert.equal(db.prepare('PRAGMA table_info(demand_signals)').all().length, 10);
    assert.deepEqual(db.prepare('SELECT id, source, signal_key, request_summary, score, status, created_at, updated_at FROM demand_signals ORDER BY id').all(), before);
  } finally {
    db.close();
  }
});
