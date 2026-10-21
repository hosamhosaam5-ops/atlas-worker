import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCard, handleA2A } from '../src/autonomy/p1.js';
import { processOrder } from '../src/orders/intake.js';
import { getFileStorage } from '../src/orders/storage.js';
import { ensureOrderSchema } from '../src/orders/schema.js';

const csv = 'name,score\nAlice,10\nBob,20\nBob,20\n';
const bytes = new TextEncoder().encode(csv);
const base64 = Buffer.from(bytes).toString('base64');
const taskId = 'a2a-sqlite-e2e-synthetic-001';
const orderId = 'X402-TEST-A2A-SQLITE-001';
const txHash = '0x' + '5a'.repeat(32);
const wallet = '0x1111111111111111111111111111111111111111';

function makeD1(filename) {
  const sqlite = new DatabaseSync(filename);
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let bound = [];
      const api = {
        bind(...values) { bound = values; return api; },
        async run(...values) {
          const result = statement.run(...(values.length ? values : bound));
          return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0) } };
        },
        async first(...values) { return statement.get(...(values.length ? values : bound)) ?? null; },
        async all(...values) { return { results: statement.all(...(values.length ? values : bound)) }; },
      };
      return api;
    },
    async execRaw(sql) { sqlite.exec(sql); },
    close() { sqlite.close(); },
  };
}

async function initializeTestDb(filename) {
  const db = makeD1(filename);
  for (const schema of ['schema.sql', 'schema-m2.sql', 'schema-m3.sql']) {
    db.prepare(readFileSync(new URL('../' + schema, import.meta.url), 'utf8')).run();
  }
  await ensureOrderSchema(db);
  await db.prepare(
    "INSERT INTO products (product_id,name,description,unit,price_usdc,pricing_mode,status,version) VALUES (?,?,?,?,?,?,?,1)"
  ).bind('atlas_ai_data_qa_v1', 'ATLAS synthetic integration fixture',
    'Test-only product; no real sale or payment', 'order', 15, 'FIXED', 'ACTIVE').run();
  return db;
}

function messageRequest(method, rpcId, messageId = taskId) {
  const params = method === 'tasks/get'
    ? { id: messageId }
    : { message: {
        messageId, role: 'user',
        parts: [{ kind: 'text', text: 'Process the attached synthetic CSV and return the QA result.' }],
        metadata: { atlas_x402: {
          client_email: 'synthetic-agent@example.test',
          file_name: 'synthetic-quality-fixture.csv',
          file_base64: base64,
          payment_signature: 'TEST_ONLY_MOCK_SETTLEMENT_NOT_A_REAL_SIGNATURE',
        } },
      } };
  return new Request('https://atlas.test/a2a', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
  });
}

test('isolated A2A -> mocked x402 settlement -> real CSV QA pipeline persists and replays result from SQLite', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-a2a-e2e-'));
  const filename = join(directory, 'atlas-test.sqlite');
  let db = await initializeTestDb(filename);
  const env = {
    DB: db,
    PAYMENT_PROVIDER: 'MOCK',
    PAYMENT_MOCK_SCENARIO: 'valid',
    PAYMENT_MOCK_AMOUNT_USDC: '15',
    ATLAS_WALLET_ADDRESS: wallet,
    EMAIL_PROVIDER: 'MOCK',
    FILE_STORAGE: 'LOCAL',
  };
  const originalFetch = globalThis.fetch;
  let delegatedCalls = 0;
  let actualPipelineCalls = 0;

  t.after(() => {
    globalThis.fetch = originalFetch;
    try { db.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });

  globalThis.fetch = async (url, init = {}) => {
    delegatedCalls++;
    assert.equal(String(url), 'https://atlas.test/x402/atlas_ai_data_qa_v1',
      'A2A must delegate only to its canonical x402 resource');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['PAYMENT-SIGNATURE'], 'TEST_ONLY_MOCK_SETTLEMENT_NOT_A_REAL_SIGNATURE');
    const input = JSON.parse(init.body);
    assert.equal(input.client_email, 'synthetic-agent@example.test');
    assert.equal(input.file_name, 'synthetic-quality-fixture.csv');
    assert.equal(input.file_base64, base64);

    // This replaces only the network/facilitator settlement boundary. The actual
    // order processor, SQLite ledger, CSV parsing/QA, file storage and MOCK email
    // adapter all run for real against this isolated temporary database.
    actualPipelineCalls++;
    const order = await processOrder(db, env, {
      client_email: input.client_email,
      tx_hash: txHash,
      __file_name: input.file_name,
      __file_bytes: Uint8Array.from(Buffer.from(input.file_base64, 'base64')),
      __order_id: orderId,
      __x402_expected_amount: 15,
      __x402_product_id: 'atlas_ai_data_qa_v1',
      __settlement_mode: 'MOCK',
    });
    return new Response(JSON.stringify({
      ok: order.order_status === 'DELIVERED',
      order: {
        order_id: order.order_id,
        order_status: order.order_status,
        payment_status: order.payment_status,
        rows_in: order.rows_in,
        rows_out: order.rows_out,
        qa_report: order.qa_report,
      },
    }), { status: order.order_status === 'DELIVERED' ? 200 : 500,
      headers: { 'content-type': 'application/json' } });
  };

  try {
    assert.equal(agentCard('https://atlas.test').name, 'ATLAS');
    const firstResponse = await handleA2A(messageRequest('message/send', 'rpc-first'), env);
    assert.equal(firstResponse.status, 200);
    const firstBody = await firstResponse.json();
    assert.equal(firstBody.result.id, taskId);
    assert.equal(firstBody.result.status.state, 'completed');
    const firstResult = firstBody.result.artifacts[0].parts[0].data;
    assert.equal(firstResult.order_id, orderId);
    assert.equal(firstResult.order_status, 'DELIVERED');
    assert.equal(firstResult.payment_status, 'PAID');
    assert.equal(firstResult.rows_in, 3);
    assert.equal(firstResult.rows_out, 2);
    assert.match(firstResult.qa_report, /duplicates_removed=1/);
    assert.equal(delegatedCalls, 1);
    assert.equal(actualPipelineCalls, 1);

    const ledger = await db.prepare(
      'SELECT order_id,status,payment_status,settlement_mode,rows_in,rows_out,qa_report FROM order_ledger WHERE order_id=?'
    ).bind(orderId).first();
    assert.ok(ledger, 'real order ledger row must exist');
    assert.equal(ledger.status, 'DELIVERED');
    assert.equal(ledger.payment_status, 'PAID');
    assert.equal(ledger.settlement_mode, 'MOCK');
    assert.equal(ledger.rows_in, 3);
    assert.equal(ledger.rows_out, 2);
    assert.match(ledger.qa_report, /duplicates_removed=1/);

    const storage = getFileStorage(env);
    const cleanFile = await storage.get(db, orderId, 'clean_csv');
    assert.ok(cleanFile, 'clean CSV must be persisted in order_files');
    assert.equal(new TextDecoder().decode(cleanFile.bytes), 'name,score\nAlice,10\nBob,20\n');
    const reportFile = await storage.get(db, orderId, 'qa_report');
    assert.ok(reportFile, 'QA report file must be persisted');
    assert.match(new TextDecoder().decode(reportFile.bytes), /rows_out=2/);

    const savedTask = await db.prepare(
      'SELECT task_id,status,output_json FROM agent_tasks WHERE task_id=?'
    ).bind(taskId).first();
    assert.ok(savedTask, 'A2A task row must be persisted');
    assert.equal(savedTask.status, 'COMPLETED');
    assert.equal(JSON.parse(savedTask.output_json).order_id, orderId);

    // Close and reopen the on-disk SQLite DB to prove the replay is not just in-memory.
    db.close();
    db = makeD1(filename);
    env.DB = db;

    const replayResponse = await handleA2A(messageRequest('message/send', 'rpc-replay'), env);
    assert.equal(replayResponse.status, 200);
    const replayBody = await replayResponse.json();
    assert.equal(replayBody.result.id, taskId);
    assert.equal(replayBody.result.status.state, 'completed');
    assert.deepEqual(replayBody.result.artifacts[0].parts[0].data, firstResult);
    assert.equal(delegatedCalls, 1, 'duplicate request must not re-enter mocked x402');
    assert.equal(actualPipelineCalls, 1, 'duplicate request must not process or settle twice');

    const getResponse = await handleA2A(messageRequest('tasks/get', 'rpc-get'), env);
    assert.equal(getResponse.status, 200);
    const getBody = await getResponse.json();
    assert.equal(getBody.result.status.state, 'completed');
    assert.deepEqual(getBody.result.artifacts[0].parts[0].data, firstResult);

    const counts = await db.prepare(
      'SELECT (SELECT COUNT(*) FROM agent_tasks WHERE task_id=?) AS tasks, (SELECT COUNT(*) FROM order_ledger WHERE order_id=?) AS orders'
    ).bind(taskId, orderId).first();
    assert.equal(counts.tasks, 1);
    assert.equal(counts.orders, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
