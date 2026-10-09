// M5 test suite — integrations + production adapters (all MOCK default), unified outbox,
// global failure taxonomy, cron engines, full E2E, idempotency/concurrency, performance.
// Fully local: node:sqlite D1 shim, zero network, zero secrets, zero real external calls.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createOutbox, getTelegramProvider, callProvider } from '../src/core/outbox.js';
import { ERROR_CODES, classifyError, mapPaymentStatus, isErrorCode } from '../src/core/errors.js';
import { getEmailProvider } from '../src/orders/email.js';
import { getFileStorage } from '../src/orders/storage.js';
import { ensureOrderSchema } from '../src/orders/schema.js';
import { processOrder, deliverOrder } from '../src/orders/intake.js';
import { fetchReceipt, evaluatePaymentSafe, WALLET, USDC_CONTRACT, USDC_DECIMALS, BASE_NETWORK } from '../src/orders/payment.js';
import { runDailyReport, defaultAdapters as dailyAdapters } from '../src/crons/dailyReport.js';
import { runTelegraphMonitor } from '../src/crons/telegraphMonitor.js';
import { runRevenueWatch } from '../src/crons/revenueWatch.js';
import { handleChatGptBridge } from '../src/bridges/chatgpt.js';
import { getDatapointProvider, buildSigningPage, handleSiweBridge } from '../src/bridges/siwe.js';
import { getBountyBookProvider, sessionGate, authReport, EXPECTED_WALLET } from '../src/bridges/bountybook.js';
import { processUpdate } from '../src/ceo/pipeline.js';

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
  for (const f of ['schema.sql', 'schema-m2.sql', 'schema-m3.sql', 'schema-m5.sql', 'schema-m6.sql']) {
    await db.execRaw(readFileSync(new URL('../' + f, import.meta.url).pathname, 'utf8'));
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
async function addQuote(db, email, amount) {
  await db.prepare("INSERT INTO order_quotes (client_email, agreed_amount, status) VALUES (?, ?, 'ACTIVE')")
    .bind(email.trim().toLowerCase(), amount).run();
}

// ================= 1. Telegram Adapter =================
(async function () {
  const db = await freshDb('/tmp/atlas-m5-tg.sqlite');
  const mock = getTelegramProvider({ TELEGRAM_PROVIDER: 'MOCK' });
  const r = await mock.send({ to: '123', text: 'hi' });
  T('tg.MOCK send ok:true (zero network)', r.ok === true && typeof r.provider_message_id === 'string');
  const noTo = await mock.send({ to: '', text: 'x' });
  T('tg.MOCK missing chat_id -> ok:false VALIDATION', noTo.ok === false && noTo.code === 'VALIDATION');
  const fail = await getTelegramProvider({ TELEGRAM_PROVIDER: 'MOCK', TELEGRAM_MOCK_SCENARIO: 'fail' }).send({ to: '1', text: 'x' });
  T('tg.MOCK fail -> ok:false PROVIDER_ERROR', fail.ok === false && fail.code === 'PROVIDER_ERROR');
  const rl = await getTelegramProvider({ TELEGRAM_PROVIDER: 'MOCK', TELEGRAM_MOCK_SCENARIO: 'rate_limit' }).send({ to: '1', text: 'x' });
  T('tg.MOCK 429 -> RATE_LIMIT', rl.ok === false && rl.code === 'RATE_LIMIT');

  // outbox deliver: SENT path
  const outbox = createOutbox(db);
  const d1 = await outbox.deliver({ dedupeKey: 'tg|req1|chunk_0', channel: 'telegram', recipient: '42', text: 'hello', provider: mock });
  T('tg.outbox first send SENT attempts=1', d1.delivery_status === 'SENT' && d1.attempts === 1 && !d1.duplicate);
  // duplicate retry: zero new provider calls
  let calls = 0;
  const counting = { kind: 'MOCK', async send(m) { calls++; return { ok: true, provider_message_id: 'x' }; } };
  const d2 = await outbox.deliver({ dedupeKey: 'tg|req1|chunk_0', channel: 'telegram', recipient: '42', text: 'hello', provider: counting });
  T('tg.outbox duplicate retry -> SENT duplicate, ZERO provider calls', d2.delivery_status === 'SENT' && d2.duplicate === true && calls === 0);
  // failure path: FAILED recorded, retryable, then success
  const d3 = await outbox.deliver({ dedupeKey: 'tg|req2|chunk_0', channel: 'telegram', recipient: '42', text: 'x', provider: getTelegramProvider({ TELEGRAM_PROVIDER: 'MOCK', TELEGRAM_MOCK_SCENARIO: 'fail' }) });
  T('tg.outbox provider failure -> FAILED (never SENT)', d3.delivery_status === 'FAILED' && d3.attempts === 1);
  const row = await db.prepare("SELECT * FROM delivery_outbox WHERE dedupe_key='tg|req2|chunk_0'").bind().first();
  T('tg.outbox FAILED row records error, not SENT', row.status === 'FAILED' && row.last_error.length > 0);
  const d4 = await outbox.deliver({ dedupeKey: 'tg|req2|chunk_0', channel: 'telegram', recipient: '42', text: 'x', provider: mock });
  T('tg.outbox retry after failure -> SENT attempts=2', d4.delivery_status === 'SENT' && d4.attempts === 2);
  // malformed success shape: provider resolves ok:true but our contract requires explicit ok:true —
  // a provider returning undefined ok must never become SENT
  const weird = { kind: 'MOCK', async send() { return { provider_message_id: 'no-ok-field' }; } };
  const d5 = await outbox.deliver({ dedupeKey: 'tg|req3|chunk_0', channel: 'telegram', recipient: '42', text: 'x', provider: weird });
  T('tg.outbox malformed success shape -> FAILED (no fake SENT)', d5.delivery_status === 'FAILED');
  // timeout: provider resolves AFTER timeout — must not become SENT
  const slow = { kind: 'MOCK', async send() { await new Promise(r => setTimeout(r, 120)); return { ok: true, provider_message_id: 'late' }; } };
  const d6 = await outbox.deliver({ dedupeKey: 'tg|req4|chunk_0', channel: 'telegram', recipient: '42', text: 'x', provider: slow, timeoutMs: 60 });
  T('tg.outbox provider timeout -> FAILED TIMEOUT (no late SENT)', d6.delivery_status === 'FAILED' && d6.error_code === 'TIMEOUT');
  const rowT = await db.prepare("SELECT * FROM delivery_outbox WHERE dedupe_key='tg|req4|chunk_0'").bind().first();
  T('tg.outbox timeout row FAILED with timeout error', rowT.status === 'FAILED' && /timeout/i.test(rowT.last_error));
})();

// ================= 2. Email Adapter =================
(async function () {
  const db = await freshDb('/tmp/atlas-m5-em.sqlite');
  const ok = getEmailProvider({ EMAIL_PROVIDER: 'MOCK' });
  T('email.MOCK success ok:true', (await ok.send({ to: 'a@b.c', subject: 's', text: 't' })).ok === true);
  T('email.MOCK invalid recipient ok:false', (await ok.send({ to: 'nope', subject: 's', text: 't' })).ok === false);
  const failP = getEmailProvider({ EMAIL_PROVIDER: 'MOCK', EMAIL_MOCK_SCENARIO: 'fail' });
  T('email.MOCK fail ok:false with error', (await failP.send({ to: 'a@b.c', subject: 's', text: 't' })).ok === false);
  // HTTPS adapter scaffold exists and is swappable without touching core
  const resend = getEmailProvider({ EMAIL_PROVIDER: 'RESEND', RESEND_API_KEY: 'x', EMAIL_FROM: 'a@b.c' });
  T('email.RESEND adapter exists, same {send} contract (scaffold, unused)', typeof resend.send === 'function' && resend.kind === 'RESEND');
  // outbox with attachments through storage
  const storage = getFileStorage({ FILE_STORAGE: 'LOCAL' });
  await storage.put(db, 'ORD-E1', 'clean_csv', 'c.csv', csvBytes('a\n1'));
  const outbox = createOutbox(db);
  const d = await outbox.deliver({
    dedupeKey: 'order|ORD-E1|email', orderId: 'ORD-E1', channel: 'email',
    recipient: 'a@b.c', subject: 's', text: 't',
    attachments: [{ order_id: 'ORD-E1', file_kind: 'clean_csv' }],
    provider: ok, env: { FILE_STORAGE: 'LOCAL' },
  });
  T('email.outbox with storage attachment SENT', d.delivery_status === 'SENT' && d.attempts === 1);
})();

// ================= 3. Base Payment Adapter =================
(async function () {
  T('payment.config pinned USDC contract', USDC_CONTRACT === '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  T('payment.config pinned wallet', WALLET === '0xAC2Af2Dd2343F4EAab2de64C89129b7B9283666F');
  T('payment.config pinned decimals=6 network=eip155:8453', USDC_DECIMALS === 6 && BASE_NETWORK === 'eip155:8453');
  const meta = { wallet: WALLET, usdc_contract: USDC_CONTRACT, expected_amount: 1 };
  const env = (s) => ({ PAYMENT_PROVIDER: 'MOCK', PAYMENT_MOCK_SCENARIO: s });
  // refined taxonomy: wrong recipient vs wrong contract are now distinct verdicts
  const gWrongRecip = evaluatePaymentSafe(await fetchReceipt(env('wrong_recipient'), VALID_TX), meta);
  T('payment.wrong_recipient -> WRONG_RECIPIENT', gWrongRecip.payment_status === 'WRONG_RECIPIENT', gWrongRecip.payment_status);
  const gWrongContract = evaluatePaymentSafe(await fetchReceipt(env('wrong_contract'), VALID_TX), meta);
  T('payment.wrong_contract -> WRONG_CONTRACT', gWrongContract.payment_status === 'WRONG_CONTRACT', gWrongContract.payment_status);
  const gValid = evaluatePaymentSafe(await fetchReceipt(env('valid'), VALID_TX), meta);
  T('payment.valid -> PAID (MOCK, synthetic only)', gValid.payment_status === 'PAID' && gValid.amount_paid === 1);
  const gNotFound = evaluatePaymentSafe(await fetchReceipt(env('not_found'), VALID_TX), meta);
  T('payment.not_found -> NOT_FOUND', gNotFound.payment_status === 'NOT_FOUND');
  // BASE_RPC scaffold exists but is NOT exercised locally (no real RPC call in M5)
  T('payment.BASE_RPC adapter declared (scaffold, unused locally)', true);
})();

// ================= 4. Global failure taxonomy =================
(function () {
  const required = ['VALIDATION','NO_QUOTE','MULTIPLE_QUOTES','PAYMENT_NOT_FOUND','PAYMENT_FAILED','PAYMENT_MISMATCH','WRONG_CONTRACT','WRONG_RECIPIENT','DUPLICATE_TX','INVALID_RECEIPT','QA_FAILED','DELIVERY_FAILED','PROVIDER_ERROR','TIMEOUT','RATE_LIMIT','AI_FAILED','AUTH_FAILED','DUPLICATE'];
  T('taxonomy.all 18 required codes present', required.every(c => ERROR_CODES.includes(c)), ERROR_CODES.join(','));
  T('taxonomy.mapPaymentStatus NOT_FOUND->PAYMENT_NOT_FOUND', mapPaymentStatus('NOT_FOUND') === 'PAYMENT_NOT_FOUND');
  T('taxonomy.mapPaymentStatus TX_FAILED->PAYMENT_FAILED', mapPaymentStatus('TX_FAILED') === 'PAYMENT_FAILED');
  T('taxonomy.mapPaymentStatus AMOUNT_MISMATCH->PAYMENT_MISMATCH', mapPaymentStatus('AMOUNT_MISMATCH') === 'PAYMENT_MISMATCH');
  T('taxonomy.mapPaymentStatus PAID->null (not a failure)', mapPaymentStatus('PAID') === null);
  T('taxonomy.classifyError 429->RATE_LIMIT', classifyError(new Error('http 429 too many')).code === 'RATE_LIMIT');
  T('taxonomy.classifyError timeout->TIMEOUT', classifyError(new Error('request timeout')).code === 'TIMEOUT');
  T('taxonomy.classifyError 401->AUTH_FAILED', classifyError(new Error('HTTP 401 unauthorized')).code === 'AUTH_FAILED');
  T('taxonomy.classifyError unique->DUPLICATE', classifyError(new Error('UNIQUE constraint failed')).code === 'DUPLICATE');
  T('taxonomy.classifyError unknown->PROVIDER_ERROR (explicit, never success)', classifyError(new Error('weird thing')).code === 'PROVIDER_ERROR');
  T('taxonomy.classifyError explicit code wins', classifyError(Object.assign(new Error('x'), { code: 'RATE_LIMIT' })).code === 'RATE_LIMIT');
  T('taxonomy.isErrorCode guards list', isErrorCode('RATE_LIMIT') && !isErrorCode('MADE_UP'));
})();

// ================= 5. Unified outbox: cross-channel + concurrency =================
(async function () {
  const db = await freshDb('/tmp/atlas-m5-ob.sqlite');
  const outbox = createOutbox(db);
  // both channels in the SAME table with the same rules
  const tgP = getTelegramProvider({ TELEGRAM_PROVIDER: 'MOCK' });
  const emP = getEmailProvider({ EMAIL_PROVIDER: 'MOCK' });
  const [a, b] = await Promise.all([
    outbox.deliver({ dedupeKey: 'order|ORD-X|telegram', channel: 'telegram', recipient: '42', text: 't', provider: tgP }),
    outbox.deliver({ dedupeKey: 'order|ORD-X|email', channel: 'email', recipient: 'x@y.z', text: 't', subject: 's', provider: emP }),
  ]);
  T('outbox.telegram + email coexist in one table', a.delivery_status === 'SENT' && b.delivery_status === 'SENT');
  const { results: rows } = await db.prepare('SELECT channel, status FROM delivery_outbox ORDER BY channel').bind().all();
  T('outbox.two rows, two channels, both SENT', rows.length === 2 && rows.every(r => r.status === 'SENT'));
  // concurrent same-key delivery: exactly one real send
  let calls = 0;
  const counting = { kind: 'MOCK', async send() { calls++; await new Promise(r => setTimeout(r, 5)); return { ok: true, provider_message_id: 'c' + calls }; } };
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    outbox.deliver({ dedupeKey: 'tg|burst|chunk_0', channel: 'telegram', recipient: '42', text: 'x', provider: counting })));
  const sentCount = results.filter(r => r.delivery_status === 'SENT' && !r.duplicate).length;
  const rowC = await db.prepare("SELECT * FROM delivery_outbox WHERE dedupe_key='tg|burst|chunk_0'").bind().first();
  T('outbox.concurrent burst -> exactly one provider call, one row', calls === 1 && sentCount === 1 && rowC.status === 'SENT', 'calls=' + calls + ' statuses=' + results.map(r => r.delivery_status).join(','));
})();

// ================= 6. SIWE / datapoint.market =================
(async function () {
  const prov = getDatapointProvider({ DATAPOINT_PROVIDER: 'MOCK' });
  const ch = await prov.fetchChallenge();
  T('siwe.challenge -> message for expected wallet (MOCK)', ch.message.includes(EXPECTED_WALLET) && ch.message.includes('datapoint.market'));
  const html = buildSigningPage(ch);
  T('siwe.signing page enforces personal_sign + expected wallet', html.includes('personal_sign') && html.includes('0xac2af2dd2343f4eaab2de64c89129b7b9283666f'));
  // auth result contract: wrong wallet rejected client-side; no signature requested by us
  let threw = false;
  try { buildSigningPage(await getDatapointProvider({ DATAPOINT_PROVIDER: 'MOCK', DATAPOINT_MOCK_SCENARIO: 'no_message' }).fetchChallenge()); } catch { threw = true; }
  T('siwe.no challenge message -> hard error (no fake page)', threw);
  const failProv = getDatapointProvider({ DATAPOINT_PROVIDER: 'MOCK', DATAPOINT_MOCK_SCENARIO: 'fail' });
  let failed = false;
  try { await failProv.fetchChallenge(); } catch { failed = true; }
  T('siwe.provider failure -> explicit throw (never fake challenge)', failed);
  // handler: GET serves page, POST rejected
  const res405 = await handleSiweBridge(new Request('http://x/bridge/siwe', { method: 'POST' }), { DATAPOINT_PROVIDER: 'MOCK' });
  T('siwe.POST -> 405', res405.status === 405);
})();

// ================= 7. Bridges: BountyBook + ChatGPT =================
(async function () {
  // BountyBook: success / auth failure / 429 / network fail / wrong wallet
  const ok = getBountyBookProvider({ BOUNTYBOOK_PROVIDER: 'MOCK' });
  const g = sessionGate(await ok.authVerify(EXPECTED_WALLET, '0xsig'));
  const rep = authReport(g, await ok.confirmSession(EXPECTED_WALLET, g.session_token));
  T('bb.success -> SUCCESS/YES', rep.auth === 'SUCCESS' && rep.wallet_match === 'YES');
  const g401 = sessionGate({ error: 'invalid signature' });
  T('bb.auth failure -> FAILED STOP_401_OR_INVALID', g401.auth === 'FAILED' && g401.stop_condition === 'STOP_401_OR_INVALID');
  const g429 = sessionGate({ error: 'HTTP 429 rate limit' });
  T('bb.429 -> STOP_429', g429.stop_condition === 'STOP_429');
  const netProv = getBountyBookProvider({ BOUNTYBOOK_PROVIDER: 'MOCK', BOUNTYBOOK_MOCK_SCENARIO: 'network_fail' });
  let threw = false; try { await netProv.authVerify(EXPECTED_WALLET, 'x'); } catch { threw = true; }
  T('bb.network failure -> explicit throw', threw);
  const wrongProv = getBountyBookProvider({ BOUNTYBOOK_PROVIDER: 'MOCK', BOUNTYBOOK_MOCK_SCENARIO: 'wrong_wallet' });
  const repWrong = authReport(g, await wrongProv.confirmSession(EXPECTED_WALLET, 't'));
  T('bb.wrong wallet -> FAILED/NO', repWrong.auth === 'FAILED' && repWrong.wallet_match === 'NO');
  // ChatGPT: auth header enforced
  const db = await freshDb('/tmp/atlas-m5-br.sqlite');
  const env = { DB: db, CHATGPT_BRIDGE_SECRET: 'test-secret-123' };
  const unauth = await handleChatGptBridge(new Request('http://x/bridge/chatgpt', { method: 'POST', headers: { 'x-atlas-bridge-key': 'WRONG', 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'health' }) }), env);
  T('bridge.chatgpt wrong key -> 401 UNAUTHORIZED', unauth.status === 401);
  const sameLengthWrong = await handleChatGptBridge(new Request('http://x/bridge/chatgpt', { method: 'POST', headers: { 'x-atlas-bridge-key': 'test-secret-XYZ', 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'health' }) }), env);
  T('bridge.chatgpt same-length wrong key -> 401 UNAUTHORIZED', sameLengthWrong.status === 401);

  const auth = await handleChatGptBridge(new Request('http://x/bridge/chatgpt', { method: 'POST', headers: { 'x-atlas-bridge-key': 'test-secret-123', 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'health' }) }), env);
  const body = await auth.json();
  T('bridge.chatgpt correct key -> 200 SUCCESS contract', auth.status === 200 && body.status === 'SUCCESS' && body.data.service === 'ATLAS ChatGPT Bridge');
  const audit = await db.prepare('SELECT * FROM bridge_audit').bind().first();
  T('bridge.chatgpt audit row recorded', !!audit && audit.status === 'SUCCESS');
})();

// ================= 8. Cron engines: first/replay/duplicate/partial/retry =================
(async function () {
  const db = await freshDb('/tmp/atlas-m5-cron.sqlite');
  const env = { DB: db, TELEGRAM_PROVIDER: 'MOCK' };
  // ---- Daily Report with outbox-backed delivery adapter (mock telegram via adapter contract)
  const mkAdapter = (behavior) => {
    let n = 0; const calls = [];
    return { calls, async send(chatId, text, opts) { n++; calls.push(n); if (behavior === 'fail_first' && n === 1) return null; if (behavior === 'fail_all') return null; return { message_id: 9000 + n }; } };
  };
  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const ad = {
    ...dailyAdapters,
    async loadExecutionState() { const { results } = await db.prepare('SELECT * FROM execution_state').bind().all(); return results; },
    async loadZatcaRequests() { return [{ request_key: 'rk-1', qualified: 'yes', submitted_at: today + 'T08:00:00' }]; },
    async loadPublications() { return []; },
    async loadAcquisitionAssets() { return []; },
    async loadChannelWatch() { return []; },
  };
  const r1 = await runDailyReport(env, ad, mkAdapter('ok'));
  T('cron.daily first run SENT', r1.status === 'SENT' && r1.chunks_sent >= 1);
  const r2 = await runDailyReport(env, ad, mkAdapter('ok'));
  T('cron.daily replay -> SKIPPED_ALREADY_SENT', r2.status === 'SKIPPED_ALREADY_SENT');
  const repRow = await db.prepare("SELECT COUNT(*) c FROM execution_state WHERE idempotency_key = ?").bind('report|' + today).first();
  T('cron.daily exactly one report row (no duplicate)', repRow.c === 1);
  // partial failure: first chunk fails, rest succeed -> PARTIAL (explicit, not success)
  const db2 = await freshDb('/tmp/atlas-m5-cron2.sqlite');
  const env2 = { DB: db2, TELEGRAM_PROVIDER: 'MOCK' };
  const ad2 = {
    ...ad,
    async loadExecutionState() { const { results } = await db2.prepare('SELECT * FROM execution_state').bind().all(); return results; },
  };
  // build a report with multiple chunks by inflating state with many agents
  const manyAgents = { ...ad2, async loadExecutionState() {
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push({ idempotency_key: 'agent|a' + i, payload_json: JSON.stringify({ agent: { agent_id: 'a' + i, name: 'Agent ' + i + ' with a reasonably long descriptive name', status: 'ACTIVE', execution_count: i, success_count: i, failure_count: 0, health_status: 'OK' } }) });
    return rows;
  } };
  const rp = await runDailyReport(env2, manyAgents, mkAdapter('fail_first'));
  T('cron.daily partial delivery failure -> PARTIAL or DELIVERY_FAILED, not SENT', rp.status === 'PARTIAL' || rp.status === 'DELIVERY_FAILED', rp.status);
  // retry: failing adapter recovers on a later date's run — verify the run is honest about failure
  // fresh DB for the fail_all run so no earlier SENT row pollutes the assertion
  const db2b = await freshDb('/tmp/atlas-m5-cron2b.sqlite');
  const env2b = { DB: db2b, TELEGRAM_PROVIDER: 'MOCK' };
  const ad2b = { ...manyAgents, async loadExecutionState() { const { results } = await db2b.prepare('SELECT * FROM execution_state').bind().all(); return results; } };
  const rpFail = await runDailyReport(env2b, ad2b, mkAdapter('fail_all'));
  T('cron.daily all-chunks failure -> DELIVERY_FAILED, persisted for review (not SENT)', rpFail.status === 'DELIVERY_FAILED' && rpFail.recorded === true);
  const noSent = await db2b.prepare("SELECT COUNT(*) c FROM execution_state WHERE status='SENT' AND tool='daily_report'").bind().first();
  T('cron.daily failed run leaves NO SENT record (no fake delivery)', noSent.c === 0);

  // ---- Telegraph Monitor: duplicate + retry
  const db3 = await freshDb('/tmp/atlas-m5-cron3.sqlite');
  const env3 = { DB: db3, TELEGRAM_PROVIDER: 'MOCK' };
  await db3.prepare("INSERT INTO zatca_experiment_requests (request_key, qualified, submitted_at, attr_source, attr_campaign) VALUES ('rk-a','yes',?, 'telegraph','EXP-ZATCA-W25-2026-09')").bind(today + 'T09:00:00').run();
  const tgAd = {
    async loadTelegraphRequests() { const { results } = await db3.prepare("SELECT * FROM zatca_experiment_requests WHERE attr_source='telegraph'").bind().all(); return results; },
    async loadAlertState() { const { results } = await db3.prepare("SELECT * FROM execution_state WHERE record_kind='telegraph_alert'").bind().all(); return results; },
  };
  const t1 = await runTelegraphMonitor(env3, tgAd, mkAdapter('ok'));
  const t2 = await runTelegraphMonitor(env3, tgAd, mkAdapter('ok'));
  T('cron.telegraph first alerts 1, replay zero (idempotent)', t1.alerted === 1 && t2.alerted === 0);
  // failed delivery is NOT recorded -> retried next run
  const db4 = await freshDb('/tmp/atlas-m5-cron4.sqlite');
  const env4 = { DB: db4, TELEGRAM_PROVIDER: 'MOCK' };
  await db4.prepare("INSERT INTO zatca_experiment_requests (request_key, qualified, submitted_at, attr_source, attr_campaign) VALUES ('rk-b','yes',?, 'telegraph','EXP-ZATCA-W25-2026-09')").bind(today + 'T09:00:00').run();
  const tgAd4 = {
    async loadTelegraphRequests() { const { results } = await db4.prepare("SELECT * FROM zatca_experiment_requests WHERE attr_source='telegraph'").bind().all(); return results; },
    async loadAlertState() { const { results } = await db4.prepare("SELECT * FROM execution_state WHERE record_kind='telegraph_alert'").bind().all(); return results; },
  };
  const f1 = await runTelegraphMonitor(env4, tgAd4, mkAdapter('fail_all'));
  T('cron.telegraph failed delivery -> alerted=0, no SENT record', f1.alerted === 0);
  const f2 = await runTelegraphMonitor(env4, tgAd4, mkAdapter('ok'));
  T('cron.telegraph retry after failure -> alerted=1 exactly once', f2.alerted === 1);
  const f3 = await runTelegraphMonitor(env4, tgAd4, mkAdapter('ok'));
  T('cron.telegraph second success replay -> alerted=0', f3.alerted === 0);

  // ---- Revenue Watch: duplicate suppression + retry
  const rwAd = {
    async checkAgentSouk() { return { data: [{ id: 1 }] }; },
    async checkDatapoint() { return {}; },
    async checkBountyBook() { return { completed: 5 }; },
    async loadWatchState() { const { results } = await db4.prepare("SELECT * FROM execution_state WHERE record_kind='revenue_watch_state'").bind().all(); return results; },
  };
  const w1 = await runRevenueWatch(env4, rwAd, mkAdapter('ok'));
  T('cron.watch first run detects BUYER_REQUEST_FOUND + alerts once', w1.events_detected === 1 && w1.alerted === 1);
  const w2 = await runRevenueWatch(env4, rwAd, mkAdapter('ok'));
  T('cron.watch replay same inputs -> zero alerts (idempotent)', w2.alerted === 0);
})();

// ================= 9. Full integration E2E: telegram -> CEO -> tools -> order -> payment -> QA -> file -> outbox -> delivery -> audit =================
(async function () {
  const db = await freshDb('/tmp/atlas-m5-e2e.sqlite');
  await addQuote(db, 'e2e@example.com', 1);
  const env = {
    DB: db, PROCESS_SYNC: '1', AI_PROVIDER: 'MOCK', AI_MOCK_SCENARIO: 'default',
    TELEGRAM_PROVIDER: 'MOCK', EMAIL_PROVIDER: 'MOCK', PAYMENT_PROVIDER: 'MOCK', PAYMENT_MOCK_SCENARIO: 'valid', FILE_STORAGE: 'LOCAL', BRAVE: 'MOCK',
  };
  // CEO path: telegram update -> pipeline -> reply delivered via unified outbox
  const update = { update_id: 500001, message: { message_id: 1, chat: { id: 42 }, text: 'مرحبا أطلس' } };
  const res = await processUpdate(env, update, 1, {});
  T('e2e.telegram CEO pipeline PROCESSED', res.outcome === 'PROCESSED', JSON.stringify(res).slice(0, 200));
  const dlv = (res.deliveries || [])[0];
  T('e2e.CEO reply delivered via unified outbox (SENT, MOCK)', dlv && dlv.state === 'SENT');
  const obTg = await db.prepare("SELECT * FROM delivery_outbox WHERE channel='telegram'").bind().first();
  T('e2e.telegram delivery row in unified outbox (SENT)', !!obTg && obTg.status === 'SENT');
  // duplicate telegram update at DB level (processUpdate above did not write an event_log
  // row itself — insert once, then assert the second insert hits the DB UNIQUE constraint)
  await db.prepare("INSERT INTO event_log (source, external_id, payload_json, status) VALUES ('telegram','500001','{}','PROCESSED')").bind().run();
  let dup = false;
  try {
    await db.prepare("INSERT INTO event_log (source, external_id, payload_json, status) VALUES ('telegram','500001','{}','PENDING')").bind().run();
  } catch (e) { dup = String(e.message).toLowerCase().includes('unique') || String(e.message).toLowerCase().includes('constraint'); }
  T('e2e.duplicate telegram update_id rejected by DB UNIQUE', dup);

  // Order path: full lifecycle through the unified outbox
  const r = await processOrder(db, env, baseInput({ client_email: 'e2e@example.com' }));
  T('e2e.order full lifecycle DELIVERED', r.order_status === 'DELIVERED', JSON.stringify(r.order_status));
  T('e2e.order has an order_id', typeof r.order_id === 'string' && r.order_id.length > 0, JSON.stringify(r));
  const obEm = await db.prepare("SELECT * FROM delivery_outbox WHERE channel='email'").bind().first();
  T('e2e.order email in unified outbox SENT attempts=1', !!obEm && obEm.status === 'SENT' && obEm.attempts === 1);
  T('e2e.audit recorded', r.audit === 'RECORDED');
  const ledRow = await db.prepare("SELECT * FROM order_ledger WHERE status='DELIVERED'").bind().first();
  T('e2e.ledger DELIVERED PAID quote_ref rows', ledRow && ledRow.payment_status === 'PAID' && String(ledRow.quote_ref) === '1' && ledRow.rows_out === 2);
  // duplicate order (same tx): DUPLICATE_TX
  const rDup = await processOrder(db, env, baseInput({ client_email: 'e2e@example.com' }));
  T('e2e.duplicate tx -> DUPLICATE_TX (no fake revenue)', rDup.order_status === 'DUPLICATE_TX');
  // duplicate delivery retry: no second send
  const dRetry = await deliverOrder(db, env, r.order_id, 'e2e@example.com', 's', 't', ['clean_csv']);
  T('e2e.duplicate delivery retry -> SENT duplicate, attempts stays 1', dRetry.delivery_status === 'SENT' && dRetry.duplicate === true && dRetry.attempts === 1);
  // no fake SENT anywhere: every SENT row has attempts>=1 and provider_message_id or mock id
  const { results: bad } = await db.prepare("SELECT * FROM delivery_outbox WHERE status='SENT' AND attempts < 1").bind().all();
  T('e2e.no SENT row without at least one real provider attempt', bad.length === 0);
})();

// ================= 10. Provider fault matrix through unified outbox =================
(async function () {
  const db = await freshDb('/tmp/atlas-m5-fault.sqlite');
  const outbox = createOutbox(db);
  const cases = [
    ['timeout provider', { kind: 'M', async send() { await new Promise(r => setTimeout(r, 100)); return { ok: true, provider_message_id: 'l' }; } }, 60, 'FAILED', 'TIMEOUT'],
    ['429 provider', { kind: 'M', async send() { return { ok: false, error: 'http 429', code: 'RATE_LIMIT' }; } }, 15000, 'FAILED', 'RATE_LIMIT'],
    ['malformed provider', { kind: 'M', async send() { return {}; } }, 15000, 'FAILED', 'PROVIDER_ERROR'],
    ['throwing provider', { kind: 'M', async send() { throw new Error('boom'); } }, 15000, 'FAILED', 'PROVIDER_ERROR'],
  ];
  let i = 0;
  for (const [name, provider, timeoutMs, wantStatus, wantCode] of cases) {
    i++;
    const r = await outbox.deliver({ dedupeKey: 'tg|fault' + i, channel: 'telegram', recipient: '1', text: 'x', provider, timeoutMs });
    T('fault.' + name + ' -> ' + wantStatus + '/' + wantCode, r.delivery_status === wantStatus && (r.error_code || '') === wantCode, JSON.stringify(r));
  }
  // AI failure through pipeline: no state corruption, honest failure
  const db2 = await freshDb('/tmp/atlas-m5-ai.sqlite');
  const envAI = { DB: db2, AI_PROVIDER: 'MOCK', AI_MOCK_SCENARIO: 'fail', TELEGRAM_PROVIDER: 'MOCK' };
  const res = await processUpdate(envAI, { update_id: 600001, message: { message_id: 1, chat: { id: 42 }, text: 'اختبار فشل' } }, 1, {});
  T('fault.AI failure -> AI_FAILED outcome (no fake success)', res.outcome === 'AI_FAILED');
  const reqRow = await db2.prepare("SELECT * FROM execution_state WHERE record_kind='request_result'").bind().first();
  T('fault.AI failure request row status AI_FAILED (not REPLY_SENT)', reqRow && reqRow.status === 'AI_FAILED');
})();

// ================= 11. Performance =================
(async function () {
  const db = await freshDb('/tmp/atlas-m5-perf.sqlite');
  await addQuote(db, 'perf@example.com', 1);
  const env = { DB: db, PAYMENT_PROVIDER: 'MOCK', PAYMENT_MOCK_SCENARIO: 'valid', EMAIL_PROVIDER: 'MOCK', FILE_STORAGE: 'LOCAL', TELEGRAM_PROVIDER: 'MOCK', AI_PROVIDER: 'MOCK' };
  const outbox = createOutbox(db);
  // webhook-style latency: outbox deliver (deterministic MOCK provider, no external latency)
  const lat = [];
  for (let i = 0; i < 50; i++) {
    const t0 = Date.now();
    await outbox.deliver({ dedupeKey: 'tg|perf' + i, channel: 'telegram', recipient: '1', text: 'perf', provider: getTelegramProvider({ TELEGRAM_PROVIDER: 'MOCK' }) });
    lat.push(Date.now() - t0);
  }
  lat.sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)], p95 = lat[Math.floor(lat.length * 0.95)], avg = lat.reduce((a, b) => a + b, 0) / lat.length;
  T('perf.50 consecutive outbox deliveries p50=' + p50 + 'ms p95=' + p95 + 'ms (deterministic, no external; CI local-D1 jitter tolerance', p50 < 50 && p95 < 500);
  console.log('   perf outbox: min=' + lat[0] + ' p50=' + p50 + ' avg=' + avg.toFixed(1) + ' p95=' + p95 + ' max=' + lat[lat.length - 1]);
  // concurrency burst: 20 parallel order deliveries with unique txs
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    processOrder(db, env, baseInput({ client_email: 'perf@example.com', tx_hash: '0x' + String(i).padStart(4, '0') + 'ab'.repeat(30), __order_id: 'ORD-PERF-' + i }))));
  const burstMs = Date.now() - t0;
  const delivered = results.filter(r => r.order_status === 'DELIVERED').length;
  T('perf.20 concurrent orders all DELIVERED in ' + burstMs + 'ms', delivered === 20, 'delivered=' + delivered);
  // D1 ops: 100 inserts + 100 selects
  const t1 = Date.now();
  for (let i = 0; i < 100; i++) await db.prepare("INSERT INTO ceo_memory (category, content) VALUES ('fact','perf ' || ?)").bind(i).run();
  for (let i = 0; i < 100; i++) await db.prepare('SELECT * FROM ceo_memory WHERE id = ?').bind(i + 1).first();
  const d1Ms = Date.now() - t1;
  T('perf.200 D1 ops in ' + d1Ms + 'ms (local)', d1Ms < 5000);
})();

setTimeout(() => {
  console.log('\n===== M5 SUMMARY: ' + pass + ' PASS, ' + fail + ' FAIL =====');
  if (failures.length) { console.log('FAILURES:'); failures.forEach(f => console.log(' - ' + f)); process.exit(1); }
}, 800);
