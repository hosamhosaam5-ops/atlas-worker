// M3 test suite — local only, zero network, zero secrets, zero quota.
// Bridges (3) + web_research adapter (6 scenarios) + crons (3, idempotency) + pipeline web_research.
import { parseAndAuthorize, buildBridgeResponse } from '../src/bridges/chatgpt.js';
import { buildSigningPage, getDatapointProvider } from '../src/bridges/siwe.js';
import { sessionGate, authReport, getBountyBookProvider, EXPECTED_WALLET } from '../src/bridges/bountybook.js';
import { webResearchFromBrave, classifyBraveError, evidenceFromBrave, braveSearchRaw, cleanSnippet } from '../src/ceo/webresearch.js';
import { executeActions } from '../src/ceo/tools.js';
import { buildReport, splitChunks, sanitizeForHtml, recordDelivery, runDailyReport } from '../src/crons/dailyReport.js';
import { detectDemandEvents } from '../src/crons/revenueWatch.js';
import { detectNewRequests, buildAlert, recordAlert, runTelegraphMonitor } from '../src/crons/telegraphMonitor.js';

let pass = 0, fail = 0;
const failures = [];
function T(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

// ============ BRIDGE: ChatGPT ============
(function () {
  const m1 = parseAndAuthorize({ operation: 'health' });
  T('chatgpt.parse health whitelisted', m1.reject === 'OK' && m1.whitelisted === true && m1.auth_result === 'OK');
  const m2 = parseAndAuthorize({ operation: 'execute' });
  T('chatgpt.parse non-whitelisted op rejected', m2.reject === 'REJECTED' && m2.whitelisted === false);
  const m3 = parseAndAuthorize({});
  T('chatgpt.parse empty op rejected', m3.reject === 'REJECTED');
  const m4 = parseAndAuthorize({ operation: 'read_state' });
  T('chatgpt.parse read_state ok', m4.reject === 'OK');
})();

// ============ BRIDGE: SIWE ============
(async function () {
  const provider = getDatapointProvider({ DATAPOINT_PROVIDER: 'MOCK' });
  const ch = await provider.fetchChallenge();
  T('siwe.mock challenge has message', typeof ch.message === 'string' && ch.message.includes('datapoint.market'));
  const html = buildSigningPage(ch);
  T('siwe.page contains message + expected wallet', html.includes('personal_sign') && html.includes('0xac2af2dd2343f4eaab2de64c89129b7b9283666f') && html.includes(JSON.stringify(ch.message).slice(1, 40)));
  let threw = false;
  try { buildSigningPage({}); } catch (e) { threw = String(e.message).includes('invalid datapoint SIWE challenge'); }
  T('siwe.missing message hard error (no fake page)', threw);
  const failProvider = getDatapointProvider({ DATAPOINT_PROVIDER: 'MOCK', DATAPOINT_MOCK_SCENARIO: 'no_message' });
  let threw2 = false;
  try { buildSigningPage(await failProvider.fetchChallenge()); } catch (e) { threw2 = true; }
  T('siwe.provider without message -> error', threw2);
})();

// ============ BRIDGE: BountyBook ============
(async function () {
  const ok = getBountyBookProvider({ BOUNTYBOOK_PROVIDER: 'MOCK' });
  const vr = await ok.authVerify(EXPECTED_WALLET, '0xsig');
  const g = sessionGate(vr);
  T('bountybook.gate success', g.auth === 'SUCCESS' && g.wallet_match === 'PENDING_CONFIRM');
  const conf = await ok.confirmSession(EXPECTED_WALLET, g.session_token);
  const rep = authReport(g, conf);
  T('bountybook.report wallet_match YES', rep.auth === 'SUCCESS' && rep.wallet_match === 'YES');
  const g401 = sessionGate({ error: 'invalid signature' });
  T('bountybook.401 -> STOP_401_OR_INVALID', g401.auth === 'FAILED' && g401.stop_condition === 'STOP_401_OR_INVALID');
  const g429 = sessionGate({ error: 'HTTP 429 rate limit' });
  T('bountybook.429 -> STOP_429', g429.stop_condition === 'STOP_429');
  const wrongProv = getBountyBookProvider({ BOUNTYBOOK_PROVIDER: 'MOCK', BOUNTYBOOK_MOCK_SCENARIO: 'wrong_wallet' });
  const confWrong = await wrongProv.confirmSession(EXPECTED_WALLET, 't');
  const repWrong = authReport(g, confWrong);
  T('bountybook.wrong wallet -> FAILED/NO', repWrong.auth === 'FAILED' && repWrong.wallet_match === 'NO');
})();

// ============ WEB RESEARCH adapter ============
(async function () {
  // 1) success
  const okRaw = await braveSearchRaw({ BRAVE: 'MOCK' }, 'test query');
  const out = webResearchFromBrave('test query', okRaw);
  T('web.ok returns results text', out.startsWith('نتائج البحث عن "test query"') && out.includes('example.com/1'));
  T('web.ok URL dedupe (dupe URL dropped)', (out.match(/example\.com\/1/g) || []).length === 1);
  // 2) empty
  const emptyRaw = await braveSearchRaw({ BRAVE: 'MOCK', BRAVE_MOCK_SCENARIO: 'empty' }, 'q');
  const outEmpty = webResearchFromBrave('q', emptyRaw);
  T('web.empty -> explicit error text', outEmpty.startsWith('خطأ: لا توجد نتائج بحث عن: q'));
  // 3) provider failure (500)
  const failRaw = await braveSearchRaw({ BRAVE: 'MOCK', BRAVE_MOCK_SCENARIO: 'fail' }, 'q');
  const clsFail = classifyBraveError(failRaw);
  T('web.fail 500 -> ERR_INTERNAL retryable', clsFail && clsFail.error_code === 'ERR_INTERNAL' && clsFail.retryable === true);
  const outFail = webResearchFromBrave('q', failRaw);
  T('web.fail -> no fabricated results', outFail.startsWith('خطأ:'));
  // 3b) error payload normalized so error never looks like results
  T('web.fail normalized keeps error fields', !!failRaw.error && failRaw.statusCode === 500 && Array.isArray(failRaw.web.results) && failRaw.web.results.length === 0);
  // 4) timeout
  let timeoutCaught = false;
  try { await braveSearchRaw({ BRAVE: 'MOCK', BRAVE_MOCK_SCENARIO: 'timeout' }, 'q'); } catch (e) { timeoutCaught = e.code === 'BRAVE_TIMEOUT'; }
  T('web.timeout throws timeout error', timeoutCaught);
  const clsTimeout = classifyBraveError({ error: { message: 'request timeout etimedout' } });
  T('web.timeout classified ERR_TIMEOUT retryable', clsTimeout && clsTimeout.error_code === 'ERR_TIMEOUT' && clsTimeout.retryable === true);
  // 5) malformed
  const malRaw = await braveSearchRaw({ BRAVE: 'MOCK', BRAVE_MOCK_SCENARIO: 'malformed' }, 'q');
  const outMal = webResearchFromBrave('q', malRaw);
  T('web.malformed -> explicit error, no fabrication', outMal.startsWith('خطأ:'));
  // 6) rate limit classification
  const rl = await braveSearchRaw({ BRAVE: 'MOCK', BRAVE_MOCK_SCENARIO: 'rate_limit' }, 'q');
  const clsRl = classifyBraveError(rl);
  T('web.429 -> ERR_RATE_LIMIT retryable', clsRl && clsRl.error_code === 'ERR_RATE_LIMIT' && clsRl.retryable === true);
  // cleanSnippet entity decoding
  T('web.cleanSnippet decodes entities', cleanSnippet('a &amp; b &lt;x&gt; &#39;c&#39;') === "a & b <x> 'c'");
  // evidence extraction
  const ev = evidenceFromBrave(okRaw, 0, 'test query');
  T('web.evidence ATTRIBUTED_CLAIM with limit', ev.length === 2 && ev[0].class === 'ATTRIBUTED_CLAIM' && ev[0].verification_level === 'SEARCH_SNIPPET' && typeof ev[0].evidence_limit === 'string' && ev[0].evidence_limit.length > 5);
})();

// ============ web_research inside executeActions (integration) ============
(function () {
  const item = {
    actions: [
      { id: 'action_1', tool: 'web_research', input: { query: 'سوق الطاقة' }, depends_on: null },
      { id: 'action_2', tool: 'calculator', input: { expression: '2+3*4' }, depends_on: 0 },
    ],
    risk: 'SAFE',
  };
  const braveItems = [{ web: { results: [{ title: 'R1', url: 'https://a.example/x', description: 'd1' }] } }];
  const out = executeActions(item, { correlation_id: 'c1', request_id: 'r1', stateRows: [], memRows: [], current_datetime: 'now', memoryQueryImpl: () => 'x', braveItems });
  const webRec = out.results.find(r => r.tool === 'web_research');
  T('actions.web_research SUCCEEDED with mock brave', webRec && webRec.status === 'SUCCEEDED' && String(webRec.result).includes('a.example/x'));
  const calcRec = out.results.find(r => r.tool === 'calculator');
  T('actions.calculator after web dep SUCCEEDED', calcRec && calcRec.status === 'SUCCEEDED' && String(calcRec.result).includes('= 14'));
  const evWeb = (out.evidence || []).filter(e => e.class === 'ATTRIBUTED_CLAIM');
  const evCalc = (out.evidence || []).filter(e => e.class === 'FACT');
  T('actions.evidence web + calculator present', evWeb.length === 1 && evCalc.length === 1);
  // provider failure -> FAILED record, never fabricated success
  const out2 = executeActions({ actions: [{ id: 'action_1', tool: 'web_research', input: { query: 'x' }, depends_on: null }], risk: 'SAFE' }, { correlation_id: 'c2', request_id: 'r2', stateRows: [], memRows: [], current_datetime: 'now', memoryQueryImpl: () => 'x', braveItems: [{ error: { statusCode: 429, message: 'rate limit' }, statusCode: 429 }] });
  const rec2 = out2.results[0];
  T('actions.web_research 429 -> FAILED ERR_RATE_LIMIT', rec2.status === 'FAILED' && rec2.error_code === 'ERR_RATE_LIMIT');
})();

// ============ CRON: Daily Report ============
(function () {
  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const dayStart = today + 'T00:00:00';
  const input = {
    state: [],
    events: [{ source: 'telegram', status: 'PROCESSED', created_at: dayStart + 'T10:00:00' }],
    tasks: [{ task_id: 't1', source: 'A2A', status: 'SUBMITTED', created_at: dayStart + 'T10:00:00' }],
    agents: [{ identity_id: 'a1', display_name: 'Agent One', status: 'ACTIVE' }],
    growthRuns: [{ run_id: 'g1', status: 'COMPLETED', started_at: dayStart + 'T10:00:00' }],
    growthAssets: [{ asset_id: 'ga1', asset_type: 'catalog', status: 'PUBLISHED' }],
    orders: [],
    approvals: [],
    products: [{ product_id: 'p1', name: 'Active Product', status: 'ACTIVE', pricing_mode: 'FOUNDER_QUOTE', price_usdc: 15 }],
    zatca: [{ request_key: 'rk1', qualified: 'yes', submitted_at: dayStart + 'T11:00:00', attr_source: 'telegraph' }],
    pubs: [],
    assets: [{ asset: 'a', status: 'ready' }],
    watch: [],
    date: today,
    report_id: 'report|' + today,
    already_sent: false,
  };
  const rep = buildReport(input);
  T('daily.buildReport not skipped', rep.skip === false && rep.report_id === 'report|' + today);
  const text = rep.chunks.join('\n');
  T('daily.report contains sections + stats', text.includes('ATLAS | التقرير اليومي') && text.includes('1 مهام جديدة، 1 دورات نمو، 1 أحداث واردة') && text.includes('وكلاء نشطون: 1 | أصول اكتشاف منشورة: 1') && text.includes('إيراد موثق: 0 USDC'));
  const items = sanitizeForHtml(splitChunks(rep));
  T('daily.split+sanitize html-escapes', items.length >= 1 && !items[0].text.includes('<') || items[0].text.includes('&lt;'));
  const skipped = buildReport({ ...input, already_sent: true });
  T('daily.already_sent -> skip (idempotent)', skipped.skip === true && skipped.chunks.length === 0);
  const row = recordDelivery([101, 102], rep.report_id);
  T('daily.recordDelivery row SENT with message_key', row && row.status === 'SENT' && row.message_key.includes('report|') && row.idempotency_key === rep.report_id);
  T('daily.recordDelivery empty ids -> null (no fake record)', recordDelivery([], rep.report_id) === null);
})();

// ============ CRON: Revenue Watch ============
(function () {
  const ev1 = detectDemandEvents({ souk: { data: [{ id: 1, buyer: { first_party: false } }, { id: 2, buyer: { first_party: false } }] }, dp: { sales_count: 3 }, bb: { completed: 10 }, state: [{ idempotency_key: 'watch|bb|completed', progress: 5 }] });
  const kinds = ev1.filter(e => e.item_type === 'event').map(e => e.event_kind).sort();
  T('watch.detects 3 event kinds', JSON.stringify(kinds) === JSON.stringify(['BUYER_REQUEST_FOUND', 'ORDER_RECEIVED', 'PLATFORM_RECOVERY']), JSON.stringify(kinds));
  T('watch.marker emitted for bb completed', ev1.some(e => e.item_type === 'marker' && e.idempotency_key === 'watch|bb|completed' && e.progress === 10));
  // idempotency: seen keys suppressed
  const seenState = ev1.map(e => ({ idempotency_key: e.alert_key || e.idempotency_key, progress: e.progress }));
  const ev2 = detectDemandEvents({ souk: { data: [{ id: 1, buyer: { first_party: false } }, { id: 2, buyer: { first_party: false } }] }, dp: { sales_count: 3 }, bb: { completed: 10 }, state: seenState.concat([{ idempotency_key: 'watch|bb|completed', progress: 10 }]) });
  T('watch.rerun same inputs -> zero new events (idempotent)', ev2.filter(e => e.item_type === 'event').length === 0);
  // quiet cycle: no changes -> only marker
  const ev3 = detectDemandEvents({ souk: { data: [] }, dp: {}, bb: { completed: 10 }, state: [{ idempotency_key: 'watch|bb|completed', progress: 10 }] });
  T('watch.quiet cycle -> no events, marker only', ev3.filter(e => e.item_type === 'event').length === 0 && ev3.some(e => e.item_type === 'marker'));
})();

// ============ CRON: Telegraph Monitor ============
(function () {
  const reqs = [
    { id: 7, request_key: 'rk-7', submitted_at: '2026-09-27T10:00:00', attr_content: 'محتوى <b>اختبار</b>', qualified: 'yes', business_type: 'متجر', revenue_band: '1M' },
    { id: 8, request_key: 'rk-8', submitted_at: '2026-09-27T11:00:00' },
  ];
  const state = [{ idempotency_key: 'telegraph_alert|rk-7' }];
  const fresh = detectNewRequests(reqs, state);
  T('telegraph.only new request detected', fresh.length === 1 && fresh[0].request_key === 'rk-8');
  const alert = buildAlert(fresh[0]);
  T('telegraph.alert text html-escaped + structure', alert.text.includes('Request ID: #8') && alert.text.includes('NOT_AVAILABLE') && !alert.text.includes('<b>'));
  const row = recordAlert(fresh[0], 555);
  T('telegraph.recordAlert SENT row with alert_key', row && row.idempotency_key === 'telegraph_alert|rk-8' && row.status === 'SENT');
  T('telegraph.recordAlert no message_id -> null', recordAlert(fresh[0], null) === null);
  const fresh2 = detectNewRequests(reqs, state.concat([{ idempotency_key: 'telegraph_alert|rk-8' }]));
  T('telegraph.rerun -> zero new (idempotent)', fresh2.length === 0);
})();

// ============ summary ============
setTimeout(() => {
  console.log('\n===== M3 TEST SUMMARY: ' + pass + ' PASS, ' + fail + ' FAIL =====');
  if (failures.length) { console.log('FAILURES:'); failures.forEach(f => console.log(' - ' + f)); process.exit(1); }
}, 300);
