import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFileStorage } from '../src/orders/storage.js';
import { processOrder } from '../src/orders/intake.js';

function createMemoryD1() {
  const files = new Map();
  const sqlLog = [];
  return {
    files,
    sqlLog,
    prepare(sql) {
      sqlLog.push(sql);
      let params = [];
      return {
        bind(...values) { params = values; return this; },
        async run() {
          if (sql.startsWith('INSERT INTO order_files')) {
            const [orderId, kind, name, base64] = params;
            const key = orderId + '|' + kind;
            if (files.has(key)) throw new Error('UNIQUE constraint failed: order_files.order_id, order_files.file_kind');
            files.set(key, { file_name: name, content_base64: base64 });
            return { success: true };
          }
          return { success: true };
        },
        async first() {
          if (sql.includes('FROM order_files')) {
            const [orderId, kind] = params;
            return files.get(orderId + '|' + kind) ?? null;
          }
          return null;
        },
      };
    },
  };
}

test('D1 storage adapter round-trips binary bytes and preserves filename', async () => {
  const db = createMemoryD1();
  const storage = getFileStorage({});
  const input = new Uint8Array([0, 1, 2, 127, 128, 200, 255]);
  const put = await storage.put(db, 'order-roundtrip', 'original', 'fixture.bin', input);
  const got = await storage.get(db, 'order-roundtrip', 'original');

  assert.equal(storage.kind, 'D1');
  assert.equal(put.stored, true);
  assert.equal(put.bytes, input.length);
  assert.equal(got.file_name, 'fixture.bin');
  assert.deepEqual([...got.bytes], [...input]);
  assert.equal(await storage.get(db, 'missing-order', 'original'), null);
});

test('D1 storage adapter fails closed on duplicate order/file-kind without overwriting original', async () => {
  const db = createMemoryD1();
  const storage = getFileStorage({});
  const original = new TextEncoder().encode('original content');
  await storage.put(db, 'order-duplicate', 'original', 'first.csv', original);

  await assert.rejects(
    storage.put(db, 'order-duplicate', 'original', 'replacement.csv', new TextEncoder().encode('replacement')),
    /UNIQUE/
  );
  const got = await storage.get(db, 'order-duplicate', 'original');
  assert.equal(got.file_name, 'first.csv');
  assert.equal(new TextDecoder().decode(got.bytes), 'original content');
});

test('oversized CSV is rejected before quote lookup or payment-provider path', async () => {
  const db = createMemoryD1();
  const tooLarge = new Uint8Array(1_300_001);
  const result = await processOrder(db, {
    PAYMENT_PROVIDER: 'BASE_RPC',
    SETTLEMENT_MODE: 'REAL',
  }, {
    __order_id: 'order-oversized-test',
    __file_name: 'oversized.csv',
    __file_bytes: tooLarge,
    client_email: 'synthetic@example.invalid',
    tx_hash: '0x' + '1'.repeat(64),
  });

  assert.equal(result.order_status, 'REJECTED');
  assert.match(result.reason, /FILE_SIZE_LIMIT_EXCEEDED/);
  assert.equal(result.max_file_bytes, 1_300_000);
  assert.equal(result.actual_file_bytes, 1_300_001);
  assert.equal(result.audit, 'RECORDED');
  assert.equal(db.sqlLog.some(sql => /order_quotes|fetchReceipt|payment_claim/i.test(sql)), false);
  assert.equal(db.sqlLog.some(sql => /INSERT INTO order_ledger/.test(sql)), true);
  assert.equal(db.sqlLog.some(sql => /INSERT INTO event_log/.test(sql)), true);
  assert.equal(db.files.size, 0);
});
