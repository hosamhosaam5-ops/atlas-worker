import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureOrderLedgerTxHashIndex } from '../src/orders/schema.js';

function makeD1(db) {
  return {
    prepare(sql) {
      let values = [];
      const statement = db.prepare(sql);
      const wrapper = {
        bind(...args) { values = args; return wrapper; },
        async run() { return statement.run(...values); },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; }
      };
      return wrapper;
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        for (const statement of statements) await statement.run();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

test('tx-hash index migration repairs stale predicate atomically and preserves rows', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('CREATE TABLE order_ledger (id INTEGER PRIMARY KEY, tx_hash TEXT)');
    sqlite.exec("INSERT INTO order_ledger (tx_hash) VALUES ('0xabc'), (NULL), ('')");
    sqlite.exec('CREATE UNIQUE INDEX idx_order_ledger_tx_hash ON order_ledger(tx_hash) WHERE tx_hash IS NOT NULL');
    const db = makeD1(sqlite);

    const result = await ensureOrderLedgerTxHashIndex(db);
    assert.deepEqual(result, { changed: true, reason: 'recreated' });
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM order_ledger').get().count, 3);
    assert.match(sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_order_ledger_tx_hash'").get().sql, /tx_hash\s*!=\s*''/i);

    sqlite.prepare("INSERT INTO order_ledger (tx_hash) VALUES ('')").run();
    sqlite.prepare('INSERT INTO order_ledger (tx_hash) VALUES (NULL)').run();
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM order_ledger').get().count, 5);
    assert.throws(() => sqlite.prepare("INSERT INTO order_ledger (tx_hash) VALUES ('0xabc')").run());
    assert.deepEqual(await ensureOrderLedgerTxHashIndex(db), { changed: false, reason: 'already-correct' });
  } finally {
    sqlite.close();
  }
});

test('tx-hash index migration refuses duplicate non-empty hashes without dropping the old index', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('CREATE TABLE order_ledger (id INTEGER PRIMARY KEY, tx_hash TEXT)');
    sqlite.exec("INSERT INTO order_ledger (tx_hash) VALUES ('0xdup'), ('0xdup')");
    sqlite.exec('CREATE INDEX idx_order_ledger_tx_hash ON order_ledger(tx_hash)');
    const db = makeD1(sqlite);

    await assert.rejects(() => ensureOrderLedgerTxHashIndex(db), /INDEX_MIGRATION_DUPLICATE_TX_HASH/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM order_ledger').get().count, 2);
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_order_ledger_tx_hash'").get());
  } finally {
    sqlite.close();
  }
});
