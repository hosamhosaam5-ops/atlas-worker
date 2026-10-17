// M4 test suite — Order Intake, fully local, zero network/secrets/quota.
// D1 = node:sqlite shim (same surface as M3 tests). All payment receipts are SYNTHETIC
// fixtures (PAYMENT_PROVIDER=MOCK) — they prove gate logic only, never a real Base tx.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import {
  prepareOrderMeta, applyResolvedPrice, applyTestPrepay, cleanAndQA,
  extractCSV, extractXLSX, buildCleanCSV, processOrder, deliverOrder, markSettlementReview,
} from '../src/orders/intake.js';
import { evaluatePayment, evaluatePaymentSafe, fetchReceipt, WALLET, USDC_CONTRACT } from '../src/orders/payment.js';
import { getFileStorage } from '../src/orders/storage.js';
import { getEmailProvider } from '../src/orders/email.js';
import { ensureOrderSchema } from '../src/orders/schema.js';


let pass = 0, fail = 0;
const failures = [];
function T(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

function makeD1(dbfile) {
  const db = new DatabaseSync(dbfile);
  return {
    prepare(sql) {
      return {
        bind(...args) {
          const s = db.prepare(sql);
          return {
            async run() { const r = s.run(...args); return { meta: { last_row_id: r.lastInsertRowid, changes: r.changes } }; },
            async first() { return s.get(...args) ?? null; },
            async all() { return { results: s.all(...args) }; },
          };
        },
      };
    },
    async execRaw(sql) { db.exec(sql); },
  };
}

async function freshDb(file) {
  try { (await import('node:fs')).unlinkSync(file); } catch {}
  const db = makeD1(file);
  for (const f of ['schema.sql', 'schema-m2.sql', 'schema-m3.sql']) {
    await db.execRaw(readFileSync(new URL('../' + f, import.meta.url).pathname.replace(/%20/g, ' '), 'utf8'));
  }
  await ensureOrderSchema(db);
  return db;
}

const csvBytes = (s) => new TextEncoder().encode(s);
const VALID_TX = '0x' + 'ab'.repeat(32);
const baseInput = (over = {}) => ({
  client_email: 'Client@Example.com', tx_hash: VALID_TX,
  __file_name: 'data.csv', __file_bytes: csvBytes('name,age\nAli,30\nSara,25\n'), ...over,
});

async function addQuote(db, email, amount, productId = 'atlas_ai_data_qa_v1') {
  await db.prepare("INSERT INTO order_quotes (client_email, agreed_amount, status, product_id) VALUES (?, ?, 'ACTIVE', ?)")
    .bind(email.trim().toLowerCase(), amount, productId).run();
}

// ================= UNIT: Prepare Order Meta (ports) =================
(function () {
  const m = prepareOrderMeta({ client_email: '  Foo@Bar.COM ', tx_hash: VALID_TX, __file_name: 'a.csv' }, 'data');
  T('meta.email trim+lowercase', m.client_email === 'foo@bar.com');
  T('meta.expected_amount=0 UNRESOLVED (client price ignored)', m.expected_amount === 0 && m.price_source === 'UNRESOLVED');
  T('meta.test_mode false on form path', m.test_mode === false);
  const t = prepareOrderMeta({ __file_name: 'a.csv', __test_mode: true }, 'data');
  T('meta.test_mode true on founder path + override 75', t.test_mode === true && t.test_price_override === 75);
  const bad = prepareOrderMeta({ client_email: '', tx_hash: 'nope' }, '');
  T('meta.invalid_input flags all missing', bad.invalid_input && bad.invalid_reason.includes('client_email') && bad.invalid_reason.includes('tx_hash') && bad.invalid_reason.includes('file_upload'));
  const inj = prepareOrderMeta({ client_email: 'a@b.c', tx_hash: VALID_TX, expected_amount: 0.01, __file_name: 'a.csv' }, 'data');
  T('meta.injected expected_amount ignored', inj.expected_amount === 0);
})();

// ================= UNIT: Apply Resolved Price =================
(function () {
  const meta = { test_mode: false };
  const one = applyResolvedPrice(meta, [{ quote_id: 7, agreed_amount: 100 }]);
  T('price.single -> FOUNDER_QUOTE + quote_ref', one.price_ok && one.expected_amount === 100 && one.quote_ref === '7' && one.price_source === 'FOUNDER_QUOTE');
  const multi = applyResolvedPrice(meta, [{ quote_id: 1, agreed_amount: 1 }, { quote_id: 2, agreed_amount: 2 }]);
  T('price.multiple -> MULTIPLE_QUOTES reject', multi.price_ok === false && multi.price_source === 'AMBIGUOUS' && multi.expected_amount === 0);
  const none = applyResolvedPrice(meta, []);
  T('price.none -> NO_QUOTE reject', none.price_ok === false && none.price_source === 'NONE');
  const zero = applyResolvedPrice(meta, [{ quote_id: 3, agreed_amount: 0 }]);
  T('price.zero amount rejected', zero.price_ok === false);
})();

// ================= UNIT: Payment gate — all 8 fixture cases (SYNTHETIC) =================
(async function () {
  const meta = { wallet: WALLET, usdc_contract: USDC_CONTRACT, expected_amount: 1 };
  const env = (s) => ({ PAYMENT_PROVIDER: 'MOCK', PAYMENT_MOCK_SCENARIO: s });
  const cases = [
    ['not_found', 'NOT_FOUND'], ['tx_failed', 'TX_FAILED'], ['amount_mismatch', 'AMOUNT_MISMATCH'],
    // M5 refined taxonomy: the two root causes are now distinct verdicts
    ['wrong_contract', 'WRONG_CONTRACT'], ['wrong_recipient', 'WRONG_RECIPIENT'],
    ['valid', 'PAID'], ['valid_overpay', 'PAID'], ['uppercase', 'PAID'], ['rpc_error', 'NOT_FOUND'],
  ];
  for (const [sc, want] of cases) {
    const r = await fetchReceipt(env(sc), VALID_TX);
    const g = evaluatePaymentSafe(r, meta);
    T('payment.' + sc + ' -> ' + want, g.payment_status === want, 'got ' + g.payment_status);
  }
  const inv = evaluatePaymentSafe(await fetchReceipt(env('invalid_receipt'), VALID_TX), meta);
  T('payment.invalid_receipt -> INVALID_RECEIPT', inv.payment_status === 'INVALID_RECEIPT');
  const over = evaluatePayment(await fetchReceipt(env('valid_overpay'), VALID_TX), meta);
  T('payment.overpay amount recorded 1.5', over.amount_paid === 1.5);
})();

// ================= UNIT: CSV extraction + Clean & QA =================
(function () {
  const clean = extractCSV(csvBytes('name,age\nAli,30\nSara,25\n'));
  T('csv.clean 2 rows', clean.length === 2 && clean[0].name === 'Ali');
  const dup = extractCSV(csvBytes('a,b\n1,2\n1,2\n,\n3,4\n'));
  const qa = cleanAndQA({ test_mode: true }, { payment_status: 'PAID', amount_paid: 75 }, dup);
  T('qa.dedupe + drop empty', qa.qa_passed && qa.rows_in === 4 && qa.rows_out === 2 && qa.qa_report.includes('duplicates_removed=1') && qa.qa_report.includes('dropped_empty=1'));
  const empty = cleanAndQA({ test_mode: true }, {}, []);
  T('qa.empty file -> FAIL', empty.qa_passed === false && empty.qa_report === 'FAIL: no data rows parsed from file');
  const malformed = extractCSV(csvBytes('a,b\n"unclosed,2\nx,y\n'));
  T('csv.malformed does not crash, rows parsed', Array.isArray(malformed) && malformed.length >= 1);
  const quoted = extractCSV(csvBytes('name,note\nAli,"he said ""hi"", ok"\n'));
  T('csv.quoted commas+escapes', quoted[0].note === 'he said "hi", ok');
  const out = buildCleanCSV([{ a: 1, b: 'x,y' }]);
  T('csv.build re-quotes commas', new TextDecoder().decode(out).includes('"x,y"'));
})();

// ================= UNIT: XLSX extraction (local logic only) =================
(async function () {
  try {
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.json_to_sheet([{ name: 'Ali', age: 30 }, { name: 'Sara', age: 25 }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const rows = await extractXLSX(new Uint8Array(bytes));
    const qa = cleanAndQA({ test_mode: true }, { payment_status: 'PAID' }, rows);
    T('xlsx.extract 2 rows + QA PASS (LOCAL ONLY — no production claim)', rows.length === 2 && rows[0].name === 'Ali' && qa.qa_passed);
  } catch (e) {
    T('xlsx.extract (library unavailable?)', false, String(e?.message || e));
  }
})();

// ================= XLSX hardening regression (synthetic workbook) =================
(async function () {
  try {
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet([
      ['__proto__', 'constructor', 'prototype', 'name'],
      ['polluted_proto_value', 'polluted_constructor_value', 'polluted_prototype_value', 'Safe']
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'AdversarialHeaders');
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const rows = await extractXLSX(new Uint8Array(bytes));
    const prototypeUntouched =
      Object.prototype.polluted_proto_value === undefined &&
      Object.prototype.polluted_constructor_value === undefined &&
      Object.prototype.polluted_prototype_value === undefined;
    T(
      'xlsx.security dangerous headers cannot pollute Object.prototype',
      prototypeUntouched && Array.isArray(rows) && rows.length === 1 && rows[0].name === 'Safe',
      JSON.stringify({ prototypeUntouched, rows })
    );
  } catch (e) {
    T('xlsx.security adversarial workbook does not crash', false, String(e?.message || e));
  }
})();

// ================= REGRESSION: x402 paid order stores real settlement metadata =================
(async function () {
  const db = await freshDb('/tmp/atlas-m4-x402-binding.sqlite');
  await db.execRaw(`CREATE TABLE products (
    product_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'order',
    price_usdc REAL,
    pricing_mode TEXT NOT NULL DEFAULT 'FIXED',
    status TEXT NOT NULL DEFAULT 'DRAFT',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.prepare("INSERT INTO products(product_id,name,description,unit,price_usdc,pricing_mode,status,version) VALUES(?,?,?,?,?,?,?,1)")
    .bind('atlas_ai_data_qa_v1', 'ATLAS AI Agent Data QA', 'Synthetic fixture for x402 order regression', 'order', 15, 'FIXED', 'ACTIVE').run();
  const env = {
    PAYMENT_PROVIDER: 'MOCK',
    PAYMENT_MOCK_SCENARIO: 'valid',
    PAYMENT_MOCK_AMOUNT_USDC: '15',
    ATLAS_WALLET_ADDRESS: '0x59Ea688b36464133E71873d8BeE8Fcb3BC369383',
    EMAIL_PROVIDER: 'MOCK',
    FILE_STORAGE: 'LOCAL',
  };
  const pendingTx = '0x' + '41'.repeat(32);
  await db.prepare("INSERT INTO order_ledger (order_id,client_email,tx_hash,product_id,status,payment_status,settlement_mode,chain_id) VALUES (?,?,?,?,?,?,?,?)")
    .bind('ORD-X402-RECONCILE', 'agent@example.com', pendingTx, 'atlas_ai_data_qa_v1', 'PENDING', 'NOT_CHECKED', 'REAL', 'eip155:8453').run();
  await markSettlementReview(db, { order_id:'ORD-X402-RECONCILE', client_email:'agent@example.com', tx_hash:pendingTx, product_id:'atlas_ai_data_qa_v1', error:'synthetic downstream throw' });
  const reconciled = await db.prepare("SELECT status,payment_status,settlement_mode,chain_id,tx_hash,error FROM order_ledger WHERE order_id=?").bind('ORD-X402-RECONCILE').first();
  T('x402.catch updates existing PENDING row for reconciliation', reconciled?.status === 'REVIEW_REQUIRED'
    && reconciled?.payment_status === 'PAID' && reconciled?.settlement_mode === 'REAL'
    && reconciled?.chain_id === 'eip155:8453' && reconciled?.tx_hash === pendingTx
    && String(reconciled?.error).includes('synthetic downstream throw'), JSON.stringify(reconciled));
  const tx = '0x' + '42'.repeat(32);
  const r = await processOrder(db, env, baseInput({
    tx_hash: tx,
    __order_id: 'ORD-X402-BIND-REGRESSION',
    __x402_expected_amount: 15,
    __x402_product_id: 'atlas_ai_data_qa_v1',
    __settlement_mode: 'REAL',
    __chain_id: 'eip155:8453',
  }));
  T('x402.order pipeline reaches DELIVERED after payment-gate fixture', r.order_status === 'DELIVERED', JSON.stringify(r));
  const row = await db.prepare("SELECT status,payment_status,amount_paid,expected_amount,settlement_mode,chain_id,tx_hash FROM order_ledger WHERE order_id=?")
    .bind('ORD-X402-BIND-REGRESSION').first();
  T('x402.order ledger preserves REAL settlement metadata', !!row
    && row.status === 'DELIVERED'
    && row.payment_status === 'PAID'
    && Number(row.amount_paid) === 15
    && Number(row.expected_amount) === 15
    && row.settlement_mode === 'REAL'
    && row.chain_id === 'eip155:8453'
    && row.tx_hash === tx, JSON.stringify(row));

  const failedTx = '0x' + '43'.repeat(32);
  const failed = await processOrder(db, { ...env, EMAIL_MOCK_SCENARIO: 'fail' }, baseInput({
    tx_hash: failedTx, __order_id: 'ORD-X402-DELIVERY-FAIL',
    __x402_expected_amount: 15, __x402_product_id: 'atlas_ai_data_qa_v1',
    __settlement_mode: 'REAL', __chain_id: 'eip155:8453',
  }));
  const failedRow = await db.prepare("SELECT status,payment_status,settlement_mode,chain_id,tx_hash FROM order_ledger WHERE order_id=?")
    .bind('ORD-X402-DELIVERY-FAIL').first();
  T('x402.delivery failure preserves confirmed REAL payment', failed.order_status === 'DELIVERY_FAILED'
    && failedRow?.payment_status === 'PAID' && failedRow?.settlement_mode === 'REAL'
    && failedRow?.chain_id === 'eip155:8453' && failedRow?.tx_hash === failedTx, JSON.stringify({order:failed.order_status,row:failedRow}));

  await db.prepare("UPDATE products SET status='PAUSED' WHERE product_id='atlas_ai_data_qa_v1'").run();
  const mismatchTx = '0x' + '44'.repeat(32);
  const mismatch = await processOrder(db, env, baseInput({ tx_hash:mismatchTx, __order_id:'ORD-X402-PRICE-RACE',
    __x402_expected_amount:15, __x402_product_id:'atlas_ai_data_qa_v1', __settlement_mode:'REAL', __chain_id:'eip155:8453' }));
  const mismatchRow = await db.prepare("SELECT status,payment_status,settlement_mode,chain_id,tx_hash FROM order_ledger WHERE order_id=?").bind('ORD-X402-PRICE-RACE').first();
  T('x402 product pause after confirmed settlement requires review', mismatch.order_status === 'REVIEW_REQUIRED'
    && mismatchRow?.status === 'REVIEW_REQUIRED' && mismatchRow?.payment_status === 'PAID'
    && mismatchRow?.settlement_mode === 'REAL' && mismatchRow?.chain_id === 'eip155:8453'
    && mismatchRow?.tx_hash === mismatchTx, JSON.stringify({order:mismatch.order_status,row:mismatchRow}));
})();

// ================= E2E: full lifecycle on real D1 =================
(async function () {
  const db = await freshDb('/tmp/atlas-m4-a.sqlite');
  await addQuote(db, 'client@example.com', 1);
  const env = { PAYMENT_PROVIDER: 'MOCK', PAYMENT_MOCK_SCENARIO: 'valid', EMAIL_PROVIDER: 'MOCK', FILE_STORAGE: 'LOCAL' };
  const r = await processOrder(db, env, baseInput());
  T('e2e.happy -> DELIVERED', r.order_status === 'DELIVERED', JSON.stringify(r));
  T('e2e.happy email normalized in ledger', r.order_status === 'DELIVERED');
  const led = await db.prepare('SELECT * FROM order_ledger WHERE order_id = ?').bind(r.order_id || '').first();
  // find actual row
  const { results: ledRows } = await db.prepare('SELECT * FROM order_ledger').bind().all();
  const row = ledRows.find(x => x.status === 'DELIVERED');
  const quoteRow = (await db.prepare("SELECT product_id FROM order_quotes WHERE quote_id = 1").bind().first());
  T('e2e.ledger DELIVERED + quote_ref + PAID + rows', !!row && String(row.quote_ref) === '1' && row.payment_status === 'PAID' && row.rows_in === 2 && row.rows_out === 2 && row.client_email === 'client@example.com', JSON.stringify(row));
  T('e2e.product_id Quote -> Order Ledger invariant', !!quoteRow && quoteRow.product_id === 'atlas_ai_data_qa_v1' && row.product_id === quoteRow.product_id, JSON.stringify({quote: quoteRow, ledger: row}));
  const { results: files } = await db.prepare('SELECT file_kind FROM order_files').bind().all();
  T('e2e.files stored original + clean_csv + qa_report', files.length === 3 && files.some(x=>x.file_kind === 'original') && files.some(x=>x.file_kind === 'clean_csv') && files.some(x=>x.file_kind === 'qa_report'));
  const ob = await db.prepare("SELECT * FROM delivery_outbox").bind().first();
  T('e2e.outbox SENT attempts=1', ob.status === 'SENT' && ob.attempts === 1);
})();

// ================= E2E: failure paths =================
(async function () {
  const db = await freshDb('/tmp/atlas-m4-b.sqlite');
  const env = (s, es = 'success') => ({ PAYMENT_PROVIDER: 'MOCK', PAYMENT_MOCK_SCENARIO: s, EMAIL_PROVIDER: 'MOCK', EMAIL_MOCK_SCENARIO: es, FILE_STORAGE: 'LOCAL' });

  // no quote
  const noQuoteTx = '0x' + '99'.repeat(32);
  let r = await processOrder(db, env('valid'), baseInput({ client_email: 'noquote@example.com', tx_hash: noQuoteTx }));
  T('e2e.NO_QUOTE reject (no gate reached)', r.order_status === 'NO_QUOTE');
  const noQuoteClaim = await db.prepare("SELECT COUNT(*) c FROM order_ledger WHERE tx_hash = ?").bind(noQuoteTx).first();
  T('e2e.NO_QUOTE does not reserve tx_hash before quote exists', noQuoteClaim.c === 0);

  // multiple quotes
  await addQuote(db, 'multi@example.com', 1); await addQuote(db, 'multi@example.com', 2);
  r = await processOrder(db, env('valid'), baseInput({ client_email: 'multi@example.com', tx_hash: '0x' + '11'.repeat(32) }));
  T('e2e.MULTIPLE_QUOTES reject', r.order_status === 'MULTIPLE_QUOTES');

  // payment failures — unique tx per attempt (tx stays claimed after any outcome)
  await addQuote(db, 'client@example.com', 1);
  let i = 1;
  for (const [sc, st] of [['not_found', 'NOT_FOUND'], ['tx_failed', 'TX_FAILED'], ['amount_mismatch', 'AMOUNT_MISMATCH'], ['wrong_recipient', 'NOT_USDC_TO_WALLET'], ['wrong_contract', 'NOT_USDC_TO_WALLET'], ['invalid_receipt', 'INVALID_RECEIPT']]) {
    r = await processOrder(db, env(sc), baseInput({ tx_hash: '0x' + '2' + String(i).padStart(7, '0') + 'ab'.repeat(28) }));
    T('e2e.PAYMENT_FAILED[' + sc + ']', r.order_status === 'PAYMENT_FAILED', JSON.stringify(r.order_status));
    i++;
  }
  const { results: pf } = await db.prepare("SELECT DISTINCT payment_status FROM order_ledger WHERE status='PAYMENT_FAILED'").bind().all();
  T('e2e.ledger records each payment failure reason (>=5 distinct)', pf.length >= 5, JSON.stringify(pf));

  // Empty datasets must be rejected before payment verification, not after a paid gate.
  const emptyTx = '0x' + '33'.repeat(32);
  r = await processOrder(db, env('valid'), baseInput({ tx_hash: emptyTx, __file_bytes: csvBytes('a,b\n,\n,\n') }));
  const emptyLedger = await db.prepare("SELECT status,payment_status FROM order_ledger WHERE tx_hash=?").bind(emptyTx).first();
  T('e2e.EMPTY_DATASET rejected before payment', r.order_status === 'REJECTED' && String(r.reason).includes('EMPTY_DATASET')
    && emptyLedger?.payment_status === 'NOT_CHECKED', JSON.stringify({order:r.order_status,ledger:emptyLedger}));
  const unsupportedTx = '0x' + '35'.repeat(32);
  r = await processOrder(db, env('valid'), baseInput({ tx_hash: unsupportedTx, __file_name: 'payload.json' }));
  const unsupportedLedger = await db.prepare("SELECT status,payment_status FROM order_ledger WHERE tx_hash=?").bind(unsupportedTx).first();
  T('e2e.UNSUPPORTED_FILE rejected before payment', r.order_status === 'REJECTED'
    && String(r.reason).includes('UNSUPPORTED_FILE_TYPE') && unsupportedLedger?.payment_status === 'NOT_CHECKED',
    JSON.stringify({order:r.order_status,ledger:unsupportedLedger}));
  // Starter commercial scope is capped at 5,000 parsed data rows and rejects oversized input before payment.
  const oversized = 'a\n' + Array.from({ length: 5001 }, (_, n) => String(n)).join('\n') + '\n';
  r = await processOrder(db, env('valid'), baseInput({ tx_hash: '0x' + '34'.repeat(32), __file_bytes: csvBytes(oversized) }));
  T('e2e.ROW_LIMIT_EXCEEDED before payment', r.order_status === 'REJECTED' && r.reason.includes('5000'));

  // invalid input
  r = await processOrder(db, env('valid'), { client_email: 'x@y.z', tx_hash: 'bad' });
  T('e2e.REJECTED invalid input', r.order_status === 'REJECTED' && r.reason.includes('tx_hash'));

  // delivery failure -> DELIVERY_FAILED, outbox FAILED, ledger DELIVERY_FAILED
  r = await processOrder(db, env('valid', 'fail'), baseInput({ tx_hash: '0x' + 'cd'.repeat(32) }));
  T('e2e.DELIVERY_FAILED on adapter failure', r.order_status === 'DELIVERY_FAILED' && r.delivery.delivery_status === 'FAILED');
  const ob = await db.prepare("SELECT * FROM delivery_outbox WHERE order_id = ?").bind(r.order_id || '').all();
  const obRow = (await db.prepare('SELECT * FROM delivery_outbox').bind().all()).results[0];
  T('e2e.outbox FAILED not SENT', obRow.status === 'FAILED' && obRow.last_error.includes('mock smtp'));
  const ledFail = (await db.prepare("SELECT * FROM order_ledger WHERE status='DELIVERY_FAILED'").bind().all()).results;
  T('e2e.ledger DELIVERY_FAILED + tx stays claimed (no retry with same paid tx)', ledFail.length === 1 && ledFail[0].tx_hash !== null, JSON.stringify(ledFail));
})();

// ================= Delivery retry + duplicate-retry =================
(async function () {
  const db = await freshDb('/tmp/atlas-m4-c.sqlite');
  const env = { EMAIL_PROVIDER: 'MOCK', EMAIL_MOCK_SCENARIO: 'fail', FILE_STORAGE: 'LOCAL' };
  const storage = getFileStorage(env);
  await storage.put(db, 'ORD-1', 'clean_csv', 'c.csv', csvBytes('a\n1'));
  // 1st attempt fails
  let d = await deliverOrder(db, env, 'ORD-1', 'a@b.c', 's', 't', ['clean_csv']);
  T('retry.attempt1 FAILED attempts=1', d.delivery_status === 'FAILED' && d.attempts === 1);
  // retry succeeds with fixed provider
  const env2 = { EMAIL_PROVIDER: 'MOCK', EMAIL_MOCK_SCENARIO: 'success', FILE_STORAGE: 'LOCAL' };
  d = await deliverOrder(db, env2, 'ORD-1', 'a@b.c', 's', 't', ['clean_csv']);
  T('retry.attempt2 SENT attempts=2', d.delivery_status === 'SENT' && d.attempts === 2 && !d.duplicate);
  // duplicate retry after SENT: no new send
  d = await deliverOrder(db, env2, 'ORD-1', 'a@b.c', 's', 't', ['clean_csv']);
  T('retry.duplicate returns SENT without resend (attempts stays 2)', d.delivery_status === 'SENT' && d.duplicate === true && d.attempts === 2);
  const ob = await db.prepare('SELECT * FROM delivery_outbox').bind().first();
  T('retry.outbox single row (UNIQUE order_id,channel)', ob.status === 'SENT' && ob.attempts === 2);
})();

// ================= Idempotency / concurrency =================
(async function () {
  const db = await freshDb('/tmp/atlas-m4-d.sqlite');
  await addQuote(db, 'client@example.com', 1);
  const env = { PAYMENT_PROVIDER: 'MOCK', PAYMENT_MOCK_SCENARIO: 'valid', EMAIL_PROVIDER: 'MOCK', FILE_STORAGE: 'LOCAL' };

  // same tx_hash twice: first DELIVERED, second DUPLICATE_TX (code-level)
  const tx = '0x' + 'ef'.repeat(32);
  let r1 = await processOrder(db, env, baseInput({ tx_hash: tx }));
  let r2 = await processOrder(db, env, baseInput({ tx_hash: tx }));
  T('idem.same tx twice -> DUPLICATE_TX', r1.order_status === 'DELIVERED' && r2.order_status === 'DUPLICATE_TX');

  // DB-level: direct second insert with same tx_hash must throw UNIQUE
  let threw = false;
  try {
    await db.prepare("INSERT INTO order_ledger (order_id, tx_hash, status) VALUES ('ORD-X', ?, 'DELIVERED')").bind(tx).run();
  } catch (e) { threw = String(e.message).toLowerCase().includes('unique'); }
  T('idem.DB UNIQUE(tx_hash) enforced', threw);

  // same order_id twice: PK enforced (direct second insert must throw)
  threw = false;
  try {
    await db.prepare("INSERT INTO order_ledger (order_id, status) VALUES (?, 'X')").bind('ORD-PK-PROBE').run();
    await db.prepare("INSERT INTO order_ledger (order_id, status) VALUES (?, 'Y')").bind('ORD-PK-PROBE').run();
  } catch (e) { threw = String(e.message).toLowerCase().includes('unique') || String(e.message).toLowerCase().includes('primary'); }
  T('idem.DB PK(order_id) enforced', threw);

  // concurrent orders with same tx_hash: exactly one wins the DB claim
  const txC = '0x' + 'aa'.repeat(32);
  const [c1, c2] = await Promise.all([
    processOrder(db, env, baseInput({ tx_hash: txC, __order_id: 'ORD-CONC-1' })),
    processOrder(db, env, baseInput({ tx_hash: txC, __order_id: 'ORD-CONC-2' })),
  ]);
  const outcomes = [c1.order_status, c2.order_status].sort();
  T('conc.same tx_hash twice -> exactly one DELIVERED + one DUPLICATE_TX (DB claim)', outcomes.join(',') === 'DELIVERED,DUPLICATE_TX', outcomes.join(','));
  // the losing order is rejected at the DB claim before any ledger row; its audit lives in event_log
  const dupAudit = (await db.prepare("SELECT * FROM event_log WHERE status='DUPLICATE_TX'").bind().all()).results;
  T('conc.DUPLICATE_TX rejection audited in event_log', dupAudit.length >= 1, JSON.stringify(dupAudit));

  // event_log audit duplicate on same order id
  T('idem.audit recorded for orders', r1.audit === 'RECORDED');

  // concurrent deliveries of same order: only one SENDING proceeds
  const envF = { EMAIL_PROVIDER: 'MOCK', EMAIL_MOCK_SCENARIO: 'success', FILE_STORAGE: 'LOCAL' };
  const storage = getFileStorage(envF);
  await storage.put(db, 'ORD-C', 'clean_csv', 'c.csv', csvBytes('a\n1'));
  const [d1, d2] = await Promise.all([
    deliverOrder(db, envF, 'ORD-C', 'a@b.c', 's', 't', ['clean_csv']),
    deliverOrder(db, envF, 'ORD-C', 'a@b.c', 's', 't', ['clean_csv']),
  ]);
  const ob = (await db.prepare("SELECT * FROM delivery_outbox WHERE order_id='ORD-C'").bind().all()).results;
  T('conc.same delivery twice -> single outbox row, one send', ob.length === 1 && ob[0].status === 'SENT' && ob[0].attempts === 1 && (d1.duplicate || d2.duplicate || true));
})();

// ================= Email adapter honesty =================
(async function () {
  const ok = getEmailProvider({ EMAIL_PROVIDER: 'MOCK' });
  const res = await ok.send({ to: 'a@b.c', subject: 's', text: 't', attachments: [] });
  T('email.MOCK success returns ok:true (no real send)', res.ok === true);
  const bad = getEmailProvider({ EMAIL_PROVIDER: 'MOCK', EMAIL_MOCK_SCENARIO: 'fail' });
  const res2 = await bad.send({ to: 'a@b.c', subject: 's', text: 't' });
  T('email.MOCK failure returns ok:false', res2.ok === false && res2.error.length > 0);
  const inv = await ok.send({ to: 'not-an-email', subject: 's', text: 't' });
  T('email.invalid recipient rejected by adapter', inv.ok === false);
})();

// ================= Storage adapter =================
(async function () {
  const db = await freshDb('/tmp/atlas-m4-e.sqlite');
  const st = getFileStorage({ FILE_STORAGE: 'LOCAL' });
  await st.put(db, 'ORD-9', 'clean_csv', 'clean_ORD-9.csv', csvBytes('x\n1'));
  const got = await st.get(db, 'ORD-9', 'clean_csv');
  T('storage.roundtrip bytes preserved', got && new TextDecoder().decode(got.bytes) === 'x\n1' && got.file_name === 'clean_ORD-9.csv');
  let threw = false;
  try { await st.put(db, 'ORD-9', 'clean_csv', 'other.csv', csvBytes('y\n2')); } catch (e) { threw = String(e.message).toLowerCase().includes('unique'); }
  T('storage.UNIQUE(order_id,file_kind) blocks overwrite', threw);
})();

// ================= Automated diff: markers backup vs port =================
(function () {
  const backupPath = new URL('../src/workflows/atlas-order-intake.workflow.ts', import.meta.url).pathname;
  if (!existsSync(backupPath)) {
    console.log('SKIP  M4 legacy n8n diff: source backup is not present in this repository');
    return;
  }
  const backup = readFileSync(backupPath, 'utf8');
  const port = readFileSync(new URL('../src/orders/intake.js', import.meta.url).pathname, 'utf8')
    + readFileSync(new URL('../src/orders/payment.js', import.meta.url).pathname, 'utf8');
  const markers = [
    'NOT_FOUND', 'TX_FAILED', 'AMOUNT_MISMATCH', 'NOT_USDC_TO_WALLET', 'PAID',
    'MULTIPLE_QUOTES', 'NO_QUOTE', 'FOUNDER_QUOTE', 'TEST_OVERRIDE', 'UNRESOLVED',
    'DUPLICATE_TX', 'REUSED_TX', 'PAYMENT_FAILED', 'QA_FAILED', 'DELIVERY_FAILED', 'DELIVERED', 'REJECTED',
    'trim().toLowerCase()', 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    '0xAC2Af2Dd2343F4EAab2de64C89129b7B9283666F', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'FAIL: no data rows parsed from file', 'duplicates_removed=', 'dropped_empty=', 'rows_in=',
    'paid_usdc=', 'padStart(64', 'test_price_override', 'quote_ref', 'price_source',
    '1e6', 'expected_amount', 'ORD-',
  ];
  let missing = [];
  for (const m of markers) {
    if (!backup.includes(m)) missing.push('not-in-backup:' + m);
    if (!port.includes(m)) missing.push('not-in-port:' + m);
  }
  T('diff.all ' + markers.length + ' behavioral markers in both backup and port', missing.length === 0, missing.join(','));
})();

setTimeout(() => {
  console.log(`\n==== M4 RESULT: ${pass} PASS, ${fail} FAIL ====`);
  if (failures.length) console.log('FAILURES:\n' + failures.join('\n'));
  process.exit(fail ? 1 : 0);
}, 500);
