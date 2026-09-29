// M6A — MIGRATION PATH (item 2).
// A single, ordered, idempotent path from an EMPTY D1 database to the current schema.
// Applies schema.sql -> schema-m2.sql -> schema-m3.sql -> schema-m4.sql -> schema-m5.sql
// in order, recording each in a _migrations ledger so re-running is a no-op.
// Works against both the Workers D1 binding and node:sqlite (local tests) via a tiny
// adapter: any object with .prepare(sql).run()/.all() semantics, or a node:sqlite DB.

import fs from 'node:fs';
import path from 'node:path';

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', '..');
export function migrationFiles() {
  return ['schema.sql', 'schema-m2.sql', 'schema-m3.sql', 'schema-m4.sql', 'schema-m5.sql'];
}

// Minimal uniform wrapper so the same code drives node:sqlite (sync) and D1 (async).
function wrap(db) {
  // node:sqlite DatabaseSync has .prepare().run()/.all() synchronous
  return {
    async run(sql, ...params) { db.prepare(sql).run(...params); },
    async all(sql, ...params) { return db.prepare(sql).all(...params); },
    async get(sql, ...params) { return db.prepare(sql).get(...params); },
    async exec(sql) { db.exec(sql); },
  };
}

async function ensureLedger(w) {
  await w.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

// Apply every pending migration file in order. Returns the list of files applied NOW.
export async function applyMigrations(rawDb) {
  const db = wrap(rawDb);
  await ensureLedger(db);
  const done = new Set((await db.all('SELECT name FROM _migrations')).map(r => r.name));
  const applied = [];
  for (const file of migrationFiles()) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Split into statements: strip '--' comments (full-line AND inline), then split
    // on semicolons. Schema files use '--' comments only; no semicolons appear inside
    // statement bodies. Inline '--' would otherwise leak into the DDL and break sqlite.
    const noComments = sql.split('\n').map(l => {
      const i = l.indexOf('--');
      return i === -1 ? l : l.slice(0, i);
    }).join('\n');
    for (const stmt of noComments.split(';').map(s => s.trim()).filter(Boolean)) {
      await db.exec(stmt);
    }
    // Structural transforms the DDL files cannot express (CREATE TABLE IF NOT EXISTS
    // is a no-op when the table already exists with an older shape).
    if (file === 'schema-m5.sql') await applyM5Transform(db);
    await db.run('INSERT OR IGNORE INTO _migrations (name) VALUES (?)', file);
    applied.push(file);
  }
  return applied;
}

// M4 -> M5 delivery_outbox shape change: M4 created it with UNIQUE(order_id, channel)
// and no dedupe_key; M5 requires dedupe_key NOT NULL UNIQUE. SQLite cannot ALTER away a
// table-level UNIQUE, so rebuild the table when the old shape is detected, preserving rows.
async function applyM5Transform(db) {
  const cols = (await db.all('PRAGMA table_info(delivery_outbox)')).map(c => c.name);
  if (cols.includes('dedupe_key')) return; // already M5 shape
  const has = n => cols.includes(n);
  const srcCol = (n, fallback) => (has(n) ? n : fallback);
  await db.exec(`CREATE TABLE IF NOT EXISTS delivery_outbox_m5 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    order_id TEXT,
    channel TEXT NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT,
    body TEXT,
    attachment_names TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    provider_message_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  )`);
  if (cols.length) {
    await db.exec(`INSERT OR IGNORE INTO delivery_outbox_m5 (dedupe_key, order_id, channel, recipient, subject, body, attachment_names, status, attempts, last_error, provider_message_id, created_at, updated_at)
      SELECT 'order|' || order_id || '|' || channel, order_id, channel, recipient,
        ${srcCol('subject', 'NULL')}, ${srcCol('body', 'NULL')}, ${srcCol('attachment_names', 'NULL')},
        ${srcCol('status', "'PENDING'")}, ${srcCol('attempts', '0')}, ${srcCol('last_error', 'NULL')},
        ${srcCol('provider_message_id', 'NULL')}, ${srcCol('created_at', "datetime('now')")}, ${srcCol('updated_at', 'NULL')}
      FROM delivery_outbox`);
    await db.exec('DROP TABLE delivery_outbox');
  }
  await db.exec('ALTER TABLE delivery_outbox_m5 RENAME TO delivery_outbox');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_outbox_status ON delivery_outbox(status)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_outbox_order ON delivery_outbox(order_id, channel)');
}
