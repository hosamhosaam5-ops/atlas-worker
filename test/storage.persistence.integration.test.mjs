// Isolated durability test for FILE_STORAGE=LOCAL (D1-backed order_files).
// Uses a temporary SQLite file and the repository's real schema migrations; never touches production D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFileStorage } from '../src/orders/storage.js';

function makeD1(connection) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              const result = connection.prepare(sql).run(...args);
              return { meta: { last_row_id: result.lastInsertRowid, changes: result.changes } };
            },
            async first() {
              return connection.prepare(sql).get(...args) ?? null;
            },
            async all() {
              return { results: connection.prepare(sql).all(...args) };
            },
          };
        },
      };
    },
    async execRaw(sql) {
      connection.exec(sql);
    },
  };
}

test('FILE_STORAGE=LOCAL writes and reads exact bytes after the SQLite connection is reopened', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-storage-persistence-'));
  const databasePath = join(directory, 'atlas-local.sqlite');
  let firstConnection;
  let reopenedConnection;

  try {
    firstConnection = new DatabaseSync(databasePath);
    for (const schema of [
      'schema.sql',
      'schema-m2.sql',
      'schema-m3.sql',
      'schema-m4.sql',
      'schema-m5.sql',
      'schema-m6.sql',
    ]) {
      firstConnection.exec(readFileSync(new URL('../' + schema, import.meta.url), 'utf8'));
    }

    const storage = getFileStorage({ FILE_STORAGE: 'LOCAL' });
    const orderId = 'storage-persistence-fixture';
    const original = Uint8Array.from([0, 1, 2, 3, 10, 13, 127, 128, 254, 255]);
    const originalResult = await storage.put(makeD1(firstConnection), orderId, 'original', 'binary-fixture.bin', original);

    assert.equal(originalResult.stored, true);
    assert.equal(originalResult.bytes, original.length);
    const beforeReopen = await storage.get(makeD1(firstConnection), orderId, 'original');
    assert.equal(beforeReopen.file_name, 'binary-fixture.bin');
    assert.deepEqual(beforeReopen.bytes, original);

    firstConnection.close();
    firstConnection = undefined;

    // Re-open the same SQLite file through a fresh connection, simulating a Worker/process restart.
    reopenedConnection = new DatabaseSync(databasePath);
    const reopenedD1 = makeD1(reopenedConnection);
    const afterReopen = await storage.get(reopenedD1, orderId, 'original');
    assert.equal(afterReopen.file_name, 'binary-fixture.bin');
    assert.deepEqual(afterReopen.bytes, original);

    // A duplicate key must fail rather than silently overwrite the previously stored file.
    await assert.rejects(
      storage.put(reopenedD1, orderId, 'original', 'replacement.bin', Uint8Array.from([9, 9, 9])),
      /UNIQUE constraint failed/i,
    );
    const afterDuplicate = await storage.get(reopenedD1, orderId, 'original');
    assert.equal(afterDuplicate.file_name, 'binary-fixture.bin');
    assert.deepEqual(afterDuplicate.bytes, original);
  } finally {
    try { firstConnection?.close(); } catch {}
    try { reopenedConnection?.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});
