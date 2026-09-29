// M6A — FINAL SCHEMA AUDIT (item 2) + MIGRATION TOOLING tests (item 6).
// Proves: empty-DB -> full current schema via the real migration path, then
// import tooling behavior on fixtures (valid / malformed / duplicate / missing /
// re-import idempotent / count verification).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, migrationFiles, MIGRATIONS_DIR } from '../src/core/migrate.js';
import { importRows, TABLE_MAP, validateRows, checksumRows } from '../src/core/importer.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function freshDb() { return new DatabaseSync(':memory:'); }

test('schema.migration-path: empty DB reaches full current schema via migrations', async () => {
  const db = freshDb();
  const applied = await applyMigrations(db);
  assert.deepEqual(applied, ['schema.sql', 'schema-m2.sql', 'schema-m3.sql', 'schema-m4.sql', 'schema-m5.sql']);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  for (const t of ['event_log','order_quotes','order_ledger','execution_state','ceo_memory','bridge_audit','zatca_experiment_requests','acquisition_assets','channel_watch','publications','order_files','delivery_outbox']) {
    assert.ok(tables.includes(t), 'missing table ' + t);
  }
});

test('schema.constraints: real UNIQUE/PK constraints exist in sqlite_master', async () => {
  const db = freshDb();
  await applyMigrations(db);
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all().map(r => r.sql).join('\n');
  assert.match(ddl, /UNIQUE\(source, external_id\)/);
  assert.match(ddl, /idx_order_ledger_tx_hash[\s\S]*UNIQUE/i);
  assert.match(ddl, /dedupe_key TEXT NOT NULL UNIQUE/);
  assert.match(ddl, /UNIQUE\(order_id, file_kind\)/);
  assert.match(ddl, /idempotency_key TEXT PRIMARY KEY/);
  assert.match(ddl, /quote_id INTEGER PRIMARY KEY/);
});

test('schema.idempotent-reapply: applying migrations twice is a no-op (no error, no dup)', async () => {
  const db = freshDb();
  await applyMigrations(db);
  const first = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all().map(r => r.name);
  const again = await applyMigrations(db);
  assert.deepEqual(again, []); // nothing new applied
  const second = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all().map(r => r.name);
  assert.deepEqual(second, first);
});

test('schema.race: duplicate tx_hash insert rejected at DB level', async () => {
  const db = freshDb();
  await applyMigrations(db);
  db.prepare("INSERT INTO order_ledger (order_id, client_email, tx_hash, status) VALUES ('A','a@b.c','0xabc','PENDING')").run();
  assert.throws(() => db.prepare("INSERT INTO order_ledger (order_id, client_email, tx_hash, status) VALUES ('B','a@b.c','0xabc','PENDING')").run(), /UNIQUE/);
});

test('schema.race: outbox dedupe_key concurrent double-claim resolves to one row', async () => {
  const db = freshDb();
  await applyMigrations(db);
  const ins = () => db.prepare("INSERT OR IGNORE INTO delivery_outbox (dedupe_key, order_id, channel, recipient, status) VALUES ('k','o','email','x','PENDING')").run();
  ins(); ins(); ins();
  const n = db.prepare("SELECT COUNT(*) c FROM delivery_outbox WHERE dedupe_key='k'").get().c;
  assert.equal(n, 1);
});

// ---------- item 6: DATA MIGRATION TOOLING (fixtures only) ----------
test('import.map: every n8n table has a D1 target mapping', () => {
  const needed = ['atlas_execution_state','atlas_memory','atlas_order_quotes','atlas_order_ledger','atlas_bridge_audit','zatca_experiment_requests','acquisition_assets','channel_watch','publications'];
  for (const n of needed) assert.ok(TABLE_MAP[n], 'no mapping for n8n table ' + n);
});

test('import.validate: malformed rows rejected, missing required fields flagged', () => {
  const bad1 = validateRows('atlas_order_quotes', [{ agreed_amount: 5 }]); // missing client_email
  assert.equal(bad1.valid.length, 0);
  assert.equal(bad1.errors.length, 1);
  assert.match(bad1.errors[0].reason, /client_email/);
  const bad2 = validateRows('atlas_order_quotes', [{ client_email: 'a@b.c', agreed_amount: 'not-a-number' }]);
  assert.equal(bad2.valid.length, 0);
  const good = validateRows('atlas_order_quotes', [{ client_email: 'a@b.c', agreed_amount: 5 }]);
  assert.equal(good.valid.length, 1);
});

test('import.dedupe: duplicate rows collapse before insert', () => {
  const rows = [
    { client_email: 'a@b.c', agreed_amount: 5 },
    { client_email: 'a@b.c', agreed_amount: 5 },
  ];
  const v = validateRows('atlas_order_quotes', rows);
  const d = importRows.dedupe('atlas_order_quotes', v.valid);
  assert.equal(d.length, 1);
});

test('import.idempotent-reimport: importing the same export twice yields the same row count', async () => {
  const db = freshDb();
  await applyMigrations(db);
  const rows = [
    { client_email: 'a@b.c', agreed_amount: 5, note: 'x' },
    { client_email: 'c@d.e', agreed_amount: 7, note: 'y' },
  ];
  const r1 = importRows.toTable(db, 'atlas_order_quotes', rows);
  const r2 = importRows.toTable(db, 'atlas_order_quotes', rows);
  assert.equal(r1.inserted + r1.skipped, 2);
  assert.equal(r2.inserted, 0);
  assert.equal(r2.skipped, 2);
  const n = db.prepare('SELECT COUNT(*) c FROM order_quotes').get().c;
  assert.equal(n, 2);
});

test('import.count-checksum: counts and checksums verify the migrated data', async () => {
  const db = freshDb();
  await applyMigrations(db);
  const rows = [
    { idempotency_key: 'k1', record_kind: 'ceo_state', status: 'SUCCEEDED' },
    { idempotency_key: 'k2', record_kind: 'ceo_state', status: 'PENDING' },
  ];
  importRows.toTable(db, 'atlas_execution_state', rows);
  const n = db.prepare('SELECT COUNT(*) c FROM execution_state').get().c;
  assert.equal(n, 2);
  const sum = checksumRows(rows);
  assert.equal(typeof sum, 'string');
  assert.equal(sum.length, 16);
  assert.equal(checksumRows(rows), sum); // deterministic
  assert.notEqual(checksumRows([rows[0]]), sum);
});

test('import.execution_state: upsert preserves PK idempotency on re-import', async () => {
  const db = freshDb();
  await applyMigrations(db);
  importRows.toTable(db, 'atlas_execution_state', [{ idempotency_key: 'k1', record_kind: 'ceo_state', status: 'PENDING', progress: 0 }]);
  importRows.toTable(db, 'atlas_execution_state', [{ idempotency_key: 'k1', record_kind: 'ceo_state', status: 'SUCCEEDED', progress: 100 }]);
  const row = db.prepare("SELECT status, progress FROM execution_state WHERE idempotency_key='k1'").get();
  assert.equal(row.status, 'SUCCEEDED');
  assert.equal(row.progress, 100);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM execution_state WHERE idempotency_key='k1'").get().c, 1);
});
