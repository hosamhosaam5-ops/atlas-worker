// M4 Order Intake Core — ported from backup atlas-order-intake.workflow.ts (561 lines,
// read in full). Each function names the n8n node it ports. Business rules, status
// taxonomy, error strings and comparison logic are preserved verbatim; only transport
// (n8n items -> function args, Data Table -> D1, SMTP -> EmailProvider) is adapted.
//
// Pipeline: parse form -> normalize/validate (Prepare Order Meta) -> extract file rows
// -> resolve price (quotes, FOUNDER_QUOTE only) -> payment gate (provider adapter)
// -> duplicate-tx guard -> Clean & QA -> build clean CSV + QA report -> store files
// -> outbox delivery (idempotent, SENT only on adapter ok) -> ledger + audit.

import { WALLET, USDC_CONTRACT, fetchReceipt, evaluatePaymentSafe } from './payment.js';
import { getFileStorage } from './storage.js';
import { getEmailProvider } from './email.js';
import { createOutbox } from '../core/outbox.js';

// ---------- Prepare Order Meta (verbatim port) ----------
export function prepareOrderMeta(first, hasFile) {
  const fileKeys = hasFile ? [hasFile] : [];
  // Public callers must provide real order credentials. Test mode is explicit and is
  // only intended for authenticated/internal callers; the public webhook never sets it.
  const testMode = first.__test_mode === true;
  const rawEmail = String(first.client_email || (testMode ? 'hosam_atlas@hotmail.com' : ''));
  // Normalize so case/whitespace variants of the same address resolve to the same founder quote row.
  const email = rawEmail.trim().toLowerCase();
  const txHash = String(first.tx_hash || (testMode ? '0x' + '1'.repeat(64) : '')).trim();
  // Price NEVER comes from the client. A form field named expected_amount is deliberately ignored.
  const missing = [];
  if (!email && !testMode) missing.push('client_email');
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) && !testMode) missing.push('tx_hash');
  if (fileKeys.length === 0) missing.push('file_upload');
  const fname = first.__file_name || '';
  const ext = fname.toLowerCase().endsWith('.xlsx') ? 'xlsx' : (fname.toLowerCase().endsWith('.csv') ? 'csv' : 'unknown');
  return {
    test_mode: testMode,
    order_id: 'ORD-' + Date.now(),
    client_email: email,
    tx_hash: txHash,
    expected_amount: 0,
    price_source: 'UNRESOLVED',
    quote_ref: '',
    file_name: fname,
    file_ext: ext,
    invalid_input: missing.length > 0,
    invalid_reason: missing.join(','),
    payment_status: 'NOT_CHECKED',
    amount_paid: 0,
    test_price_override: testMode ? 75 : 0,
    wallet: WALLET,
    usdc_contract: USDC_CONTRACT,
  };
}

// ---------- Apply Resolved Price (verbatim port) ----------
// rows = quote rows for this client_email (ALL ACTIVE rows, returnAll semantics).
export function applyResolvedPrice(meta, quoteRows) {
  if (meta.test_mode) throw new Error('Apply Resolved Price must only run on the production path');
  const rows = quoteRows.filter(r => r && Object.keys(r).length > 0);
  if (rows.length > 1) {
    return { ...meta, price_ok: false, invalid_reason: 'MULTIPLE_QUOTES: more than one quote row matches this client_email', price_source: 'AMBIGUOUS', expected_amount: 0, quote_ref: '' };
  }
  const quote = rows.length ? rows[0] : null;
  const amount = quote ? Number(quote.agreed_amount) : 0;
  if (!quote || !(amount > 0)) {
    return { ...meta, price_ok: false, invalid_reason: 'NO_QUOTE: no agreed price on record for this client_email', price_source: 'NONE', expected_amount: 0, quote_ref: '' };
  }
  const quoteRef = quote.quote_id !== undefined && quote.quote_id !== null ? String(quote.quote_id) : '';
  return { ...meta, expected_amount: amount, price_source: 'FOUNDER_QUOTE', price_ok: true, quote_ref: quoteRef };
}

// ---------- Apply Test Prepay (verbatim port; founder test path only) ----------
export function applyTestPrepay(meta) {
  if (!meta.test_mode) throw new Error('Apply Test Prepay must only run on the test path');
  const testPrice = meta.test_price_override > 0 ? meta.test_price_override : 0;
  return { ...meta, expected_amount: testPrice, price_source: 'TEST_OVERRIDE', payment_status: 'PAID', amount_paid: testPrice, payment_detail: 'test-mode prepay' };
}

// ---------- Clean and QA (verbatim port) ----------
export function cleanAndQA(meta, gateResult, rows) {
  // Payment decision comes from the gate that actually ran, rows come from extraction.
  meta = { ...meta, ...gateResult };
  const rowsIn = rows.length;
  if (rowsIn === 0) {
    return { qa_passed: false, qa_report: 'FAIL: no data rows parsed from file', rows_in: 0, rows_out: 0, clean_rows: [], ...meta };
  }
  // normalize
  rows = rows.map(r => {
    const out = {};
    for (const k of Object.keys(r)) {
      let v = r[k];
      if (typeof v === 'string') v = v.trim();
      if (v === '' || v === null || v === undefined) v = null;
      out[k.trim()] = v;
    }
    return out;
  });
  // drop fully-empty rows
  const beforeDrop = rows.length;
  rows = rows.filter(r => Object.values(r).some(v => v !== null));
  const droppedEmpty = beforeDrop - rows.length;
  // dedupe
  const seen = new Set();
  let dupes = 0;
  const deduped = [];
  for (const r of rows) {
    const key = JSON.stringify(r);
    if (seen.has(key)) { dupes++; } else { seen.add(key); deduped.push(r); }
  }
  const rowsOut = deduped.length;
  // per-column empty stats
  const cols = {};
  for (const r of deduped) for (const k of Object.keys(r)) cols[k] = cols[k] || { empty: 0, total: 0 };
  for (const r of deduped) for (const k of Object.keys(cols)) {
    cols[k].total++;
    if (r[k] === null || r[k] === undefined) cols[k].empty++;
  }
  const colReport = Object.keys(cols).map(k => k + ': ' + cols[k].empty + '/' + cols[k].total + ' empty').join('; ');
  const qaPassed = rowsOut > 0;
  const qaReport = (qaPassed ? 'PASS' : 'FAIL')
    + ' | rows_in=' + rowsIn
    + ' | dropped_empty=' + droppedEmpty
    + ' | duplicates_removed=' + dupes
    + ' | rows_out=' + rowsOut
    + ' | columns: ' + colReport;
  return { qa_passed: qaPassed, qa_report: qaReport, rows_in: rowsIn, rows_out: rowsOut, clean_rows: deduped, ...meta };
}

// ---------- CSV / XLSX extraction (ports Extract CSV / Extract XLSX nodes) ----------
// headerRow: true; relaxQuotes: true for CSV (same options as the n8n nodes).
export function extractCSV(bytes) {
  const text = new TextDecoder('utf-8').decode(bytes);
  const rows = [];
  let field = '', row = [], inQuotes = false, header = null;
  const pushRow = () => {
    row.push(field); field = '';
    if (header === null) { header = row; }
    else if (row.length > 1 || row[0] !== '') {
      const obj = {};
      header.forEach((h, i) => { obj[h] = i < row.length ? row[i] : ''; });
      rows.push(obj);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') pushRow();
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field !== '' || row.length) pushRow();
  return rows;
}

// XLSX via the `xlsx` npm package (SheetJS CE — works in Workers, no native deps).
// NOTE: local proof of logic only; production XLSX performance under Worker limits
// is NOT claimed by this port (per founder instruction 6).
export async function extractXLSX(bytes) {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(bytes, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

// ---------- Build Clean CSV (ports Build Clean CSV convertToFile) ----------
export function buildCleanCSV(cleanRows) {
  if (!cleanRows.length) return new TextEncoder().encode('');
  const headers = Object.keys(cleanRows[0]);
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(esc).join(',')];
  for (const r of cleanRows) lines.push(headers.map(h => esc(r[h])).join(','));
  return new TextEncoder().encode(lines.join('\n'));
}

// ---------- Ledger + audit ----------
async function insertLedger(db, row) {
  await db.prepare(
    `INSERT INTO order_ledger (order_id, client_email, tx_hash, quote_ref, status, qa_status, qa_report,
      payment_status, amount_paid, price_source, expected_amount, file_name, file_ext, rows_in, rows_out,
      delivery_channel, delivery_status, error, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`
  ).bind(
    row.order_id ?? null, row.client_email ?? null, row.tx_hash ?? null, row.quote_ref ?? null,
    row.status, row.qa_status ?? null, row.qa_report ?? null, row.payment_status ?? null,
    row.amount_paid ?? null, row.price_source ?? null, row.expected_amount ?? null,
    row.file_name ?? null, row.file_ext ?? null, row.rows_in ?? null, row.rows_out ?? null,
    row.delivery_channel ?? null, row.delivery_status ?? null, row.last_error ?? null
  ).run();
}


// Finalize the PENDING payment-claim row (created before the gate) with the terminal state.
// The tx_hash stays claimed regardless of outcome: a paid-then-failed order can never be
// re-submitted with the same tx (no free redelivery).
async function finalizeLedger(db, orderId, row) {
  await db.prepare(
    `UPDATE order_ledger SET status=?, qa_status=?, qa_report=?, payment_status=?, amount_paid=?,
       price_source=?, expected_amount=?, quote_ref=?, file_name=?, file_ext=?, rows_in=?, rows_out=?,
       delivery_channel=?, delivery_status=?, error=?, updated_at=datetime('now')
     WHERE order_id=?`
  ).bind(
    row.status, row.qa_status ?? null, row.qa_report ?? null, row.payment_status ?? null,
    row.amount_paid ?? null, row.price_source ?? null, row.expected_amount ?? null,
    row.quote_ref ?? null, row.file_name ?? null, row.file_ext ?? null,
    row.rows_in ?? null, row.rows_out ?? null, row.delivery_channel ?? null,
    row.delivery_status ?? null, row.last_error ?? null, orderId
  ).run();
}

async function audit(db, source, externalId, payload, status, error) {
  try {
    await db.prepare(
      "INSERT INTO event_log (source, external_id, payload_json, status, error) VALUES (?, ?, ?, ?, ?)"
    ).bind(source, String(externalId), JSON.stringify(payload), status, error ?? null).run();
  } catch (e) {
    // UNIQUE(source, external_id) — a retried order id collides; that is the idempotency proof.
    return 'DUPLICATE';
  }
  return 'RECORDED';
}

// ---------- Delivery (M5 unified outbox) ----------
// Exactly-once per order via dedupe_key 'order|<orderId>|email'. SENT only on adapter
// ok:true — the unified outbox owns claim/settle; this wrapper keeps the M4 signature.
export async function deliverOrder(db, env, orderId, recipient, subject, text, attachmentKinds) {
  const outbox = createOutbox(db);
  const res = await outbox.deliver({
    dedupeKey: 'order|' + orderId + '|email',
    orderId,
    channel: 'email',
    recipient,
    subject,
    text,
    attachments: (attachmentKinds || []).map(k => ({ order_id: orderId, file_kind: k })),
    provider: getEmailProvider(env),
    timeoutMs: Number(env.EMAIL_TIMEOUT_MS || 15000),
    env,
  });
  return {
    delivery_status: res.delivery_status,
    delivery_error: res.error,
    duplicate: res.duplicate,
    attempts: res.attempts,
  };
}

// ---------- Full order pipeline ----------
// input: { client_email?, tx_hash?, __file_name, __file_bytes } (form fields + uploaded file)
export async function processOrder(db, env, input) {
  const t0 = Date.now();
  const hasFile = input.__file_bytes ? 'data' : '';
  const meta = prepareOrderMeta({
    client_email: input.client_email,
    tx_hash: input.tx_hash,
    __file_name: input.__file_name,
    __test_mode: input.__test_mode === true,
  }, hasFile);
  if (input.__order_id) meta.order_id = String(input.__order_id); // stable id for idempotency tests

  // --- Input Valid gate (ports Reject Invalid Input branch) ---
  if (meta.invalid_input) {
    await insertLedger(db, {
      order_id: meta.order_id, client_email: meta.client_email, tx_hash: meta.tx_hash,
      status: 'REJECTED', payment_status: 'NOT_CHECKED', last_error: meta.invalid_reason,
    });
    const a = await audit(db, 'order', meta.order_id, meta, 'REJECTED', meta.invalid_reason);
    return { order_id: meta.order_id, order_status: 'REJECTED', reason: 'Invalid or missing fields: ' + meta.invalid_reason, audit: a, latency_ms: Date.now() - t0 };
  }

  // --- Extract rows (ports Extract CSV / Extract XLSX + Repack File Binary) ---
  let rows = [];
  let extractError = null;
  try {
    if (meta.file_ext === 'xlsx') rows = await extractXLSX(input.__file_bytes);
    else rows = extractCSV(input.__file_bytes);
  } catch (e) {
    extractError = String(e?.message || e);
  }
  if (extractError) {
    await insertLedger(db, {
      order_id: meta.order_id, client_email: meta.client_email, tx_hash: meta.tx_hash,
      status: 'REJECTED', payment_status: 'NOT_CHECKED', file_name: meta.file_name, file_ext: meta.file_ext,
      last_error: 'file_parse_error: ' + extractError,
    });
    const a = await audit(db, 'order', meta.order_id, meta, 'REJECTED', 'file_parse_error');
    return { order_id: meta.order_id, order_status: 'REJECTED', reason: 'Could not parse uploaded file: ' + extractError, audit: a, latency_ms: Date.now() - t0 };
  }

  let gate;   // the node-that-actually-ran payment result (Evaluate Payment or Apply Test Prepay)
  let priceMeta = meta;

  if (meta.test_mode) {
    gate = applyTestPrepay(meta);
  } else {
    // --- Resolve Agreed Price (production only) ---
    const { results: quoteRows } = await db.prepare(
      "SELECT quote_id, client_email, agreed_amount FROM order_quotes WHERE client_email = ? AND status = 'ACTIVE'"
    ).bind(meta.client_email).all();
    priceMeta = applyResolvedPrice(meta, quoteRows);
    if (!priceMeta.price_ok) {
      const status = priceMeta.price_source === 'AMBIGUOUS' ? 'MULTIPLE_QUOTES' : 'NO_QUOTE';
      await finalizeLedger(db, meta.order_id, {
        status, payment_status: 'NOT_CHECKED', price_source: priceMeta.price_source,
        last_error: priceMeta.invalid_reason,
      });
      const a = await audit(db, 'order', meta.order_id, meta, status, priceMeta.invalid_reason);
      return { order_id: meta.order_id, order_status: status, message: priceMeta.invalid_reason, audit: a, latency_ms: Date.now() - t0 };
    }

    // --- Race-safe payment claim (production only): reserve tx_hash only AFTER a valid
    // founder quote exists. A no-quote request must not consume a customer's payment hash.
    // The DB UNIQUE(tx_hash) constraint remains the concurrency authority.
    try {
      await db.prepare("INSERT INTO order_ledger (order_id, client_email, tx_hash, status, payment_status) VALUES (?, ?, ?, 'PENDING', 'NOT_CHECKED')")
        .bind(meta.order_id, meta.client_email, meta.tx_hash).run();
    } catch (e) {
      if (String(e?.message || e).toLowerCase().includes('unique')) {
        const a = await audit(db, 'order', meta.order_id, meta, 'DUPLICATE_TX', 'tx_hash claimed concurrently (DB UNIQUE)');
        return { order_id: meta.order_id, order_status: 'DUPLICATE_TX', message: 'This payment transaction was already used or is being processed. Order rejected.', audit: a, latency_ms: Date.now() - t0 };
      }
      throw e;
    }

    // --- Check Tx Already Used (DB-level + code-level duplicate protection) ---
    const used = await db.prepare(
      "SELECT order_id FROM order_ledger WHERE tx_hash = ? AND status = 'DELIVERED' LIMIT 1"
    ).bind(meta.tx_hash).first();
    if (used) {
      await finalizeLedger(db, meta.order_id, {
        status: 'DUPLICATE_TX', payment_status: 'REUSED_TX', file_name: meta.file_name,
        price_source: priceMeta.price_source, expected_amount: priceMeta.expected_amount, quote_ref: priceMeta.quote_ref,
        last_error: 'same tx_hash already DELIVERED in ledger (used by ' + used.order_id + ')',
      });
      const a = await audit(db, 'order', meta.order_id, meta, 'DUPLICATE_TX', 'tx reused');
      return { order_id: meta.order_id, order_status: 'DUPLICATE_TX', message: 'This payment transaction was already used for a delivered order. Order rejected.', audit: a, latency_ms: Date.now() - t0 };
    }

    // --- Payment gate (Evaluate Payment via provider adapter; fixtures are SYNTHETIC) ---
    const receipt = await fetchReceipt(env, meta.tx_hash);
    gate = evaluatePaymentSafe(receipt, priceMeta);
    if (gate.payment_status !== 'PAID') {
      await finalizeLedger(db, meta.order_id, {
        status: 'PAYMENT_FAILED', payment_status: gate.payment_status, amount_paid: gate.amount_paid,
        price_source: priceMeta.price_source, expected_amount: priceMeta.expected_amount,
        quote_ref: priceMeta.quote_ref, file_name: meta.file_name, file_ext: meta.file_ext,
        last_error: gate.payment_detail,
      });
      const a = await audit(db, 'order', meta.order_id, meta, 'PAYMENT_FAILED', gate.payment_status);
      return { order_id: meta.order_id, order_status: 'PAYMENT_FAILED', message: 'Payment not confirmed: ' + gate.payment_status + ' (' + gate.payment_detail + '). Order recorded for founder review.', audit: a, latency_ms: Date.now() - t0 };
    }
  }

  // --- Clean and QA ---
  const qa = cleanAndQA(meta, gate, rows);
  if (!qa.qa_passed) {
    if (meta.test_mode) {
      await insertLedger(db, {
        order_id: meta.order_id, client_email: meta.client_email, tx_hash: null,
        status: 'QA_FAILED', qa_status: 'FAIL', qa_report: qa.qa_report,
        payment_status: qa.payment_status, amount_paid: qa.amount_paid,
        price_source: qa.price_source, expected_amount: qa.expected_amount, quote_ref: qa.quote_ref,
        file_name: meta.file_name, file_ext: meta.file_ext, rows_in: qa.rows_in, rows_out: qa.rows_out,
        last_error: qa.qa_report,
      });
    } else {
      await finalizeLedger(db, meta.order_id, {
        status: 'QA_FAILED', qa_status: 'FAIL', qa_report: qa.qa_report,
        payment_status: qa.payment_status, amount_paid: qa.amount_paid,
        price_source: qa.price_source, expected_amount: qa.expected_amount, quote_ref: qa.quote_ref,
        file_name: meta.file_name, file_ext: meta.file_ext, rows_in: qa.rows_in, rows_out: qa.rows_out,
        last_error: qa.qa_report,
      });
    }
    const a = await audit(db, 'order', meta.order_id, meta, 'QA_FAILED', qa.qa_report);
    return { order_id: meta.order_id, order_status: 'QA_FAILED', message: 'QA failed — founder review required. Order recorded.', qa_report: qa.qa_report, audit: a, latency_ms: Date.now() - t0 };
  }

  // --- Build delivery files + store (ports Build Clean CSV / QA report / convertToFile) ---
  const storage = getFileStorage(env);
  const cleanCsv = buildCleanCSV(qa.clean_rows);
  const qaText = new TextEncoder().encode(qa.qa_report);
  await storage.put(db, meta.order_id, 'clean_csv', `clean_${meta.order_id}.csv`, cleanCsv);
  await storage.put(db, meta.order_id, 'qa_report', `qa_${meta.order_id}.txt`, qaText);

  // --- Delivery (outbox, idempotent) ---
  const subject = `ATLAS order ${meta.order_id} — cleaned data + QA report`;
  const text = `Order ${meta.order_id} complete.\n\nQA: ${qa.qa_report}\n\nAttached: cleaned CSV and QA report.`;
  const dlv = await deliverOrder(db, env, meta.order_id, meta.client_email, subject, text, ['clean_csv', 'qa_report']);

  // --- Final ledger (ports Log Delivered / Respond Final) ---
  const finalStatus = dlv.delivery_status === 'SENT' ? 'DELIVERED' : 'DELIVERY_FAILED';
  const finalRow = {
    status: finalStatus, qa_status: 'PASS', qa_report: qa.qa_report,
    payment_status: qa.payment_status, amount_paid: qa.amount_paid,
    price_source: qa.price_source, expected_amount: qa.expected_amount, quote_ref: qa.quote_ref,
    file_name: meta.file_name, file_ext: meta.file_ext, rows_in: qa.rows_in, rows_out: qa.rows_out,
    delivery_channel: 'email', delivery_status: dlv.delivery_status,
    last_error: dlv.delivery_error || null,
  };
  if (meta.test_mode) {
    await insertLedger(db, { order_id: meta.order_id, client_email: meta.client_email, tx_hash: null, ...finalRow });
  } else {
    await finalizeLedger(db, meta.order_id, finalRow);
  }

  const a = await audit(db, 'order', meta.order_id, meta, finalStatus, dlv.delivery_error || null);
  return {
    order_id: meta.order_id,
    order_status: finalStatus, delivery: dlv, qa_report: qa.qa_report,
    rows_in: qa.rows_in, rows_out: qa.rows_out, quote_ref: qa.quote_ref,
    payment_status: qa.payment_status, amount_paid: qa.amount_paid,
    message: 'Order processed. Delivery by email.', audit: a, latency_ms: Date.now() - t0,
  };
}
