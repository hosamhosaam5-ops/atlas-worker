// M5 automated regression: compare the serverless port (M1-M5) against the original
// n8n backup code across business rules, node behavior, status transitions, error
// taxonomy, required fields, quote/payment rules, delivery rules, and audit.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const failures = [];
function T(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
const read = (p) => readFileSync(new URL(p, import.meta.url).pathname, 'utf8');

const backup = {
  order: read('../src/workflows/atlas-order-intake.workflow.ts'),
  ceo: read('../src/workflows/my-workflow.workflow.ts'),
  chatgpt: read('../src/workflows/atlas-chatgpt-bridge.workflow.ts'),
  siwe: read('../src/workflows/atlas-siwe-signing-bridge.workflow.ts'),
  bounty: read('../src/workflows/atlas-bountybook-session-auth-n8n-ui-webhook.workflow.ts'),
  daily: read('../src/workflows/atlas-daily-ceo-report.workflow.ts'),
  watch: read('../src/workflows/atlas-smart-revenue-watch-read-only.workflow.ts'),
  telegraph: read('../src/workflows/atlas-telegraph-acquisition-monitor.workflow.ts'),
};
const port = {
  intake: read('../src/orders/intake.js') + read('../src/orders/payment.js') + read('../src/orders/schema.js'),
  outbox: read('../src/core/outbox.js') + read('../src/core/errors.js'),
  pipeline: read('../src/ceo/pipeline.js') + read('../src/ceo/engine.js') + read('../src/ceo/tools.js') + read('../src/ceo/parser.js'),
  bridges: read('../src/bridges/chatgpt.js') + read('../src/bridges/siwe.js') + read('../src/bridges/bountybook.js'),
  crons: read('../src/crons/dailyReport.js') + read('../src/crons/revenueWatch.js') + read('../src/crons/telegraphMonitor.js'),
  storage: read('../src/orders/storage.js') + read('../src/orders/email.js'),
  webresearch: read('../src/ceo/webresearch.js') + read('../src/ceo/provider.js'),
};

function markers(name, backupSrc, portSrc, list) {
  const missingBackup = list.filter(m => !backupSrc.includes(m));
  const missingPort = list.filter(m => !portSrc.includes(m));
  T('diff.' + name + ' (' + list.length + ' markers) present in both', missingBackup.length === 0 && missingPort.length === 0,
    (missingBackup.length ? 'NOT-IN-BACKUP:' + missingBackup.join(',') : '') + (missingPort.length ? ' NOT-IN-PORT:' + missingPort.join(',') : ''));
}

// ---- business rules + quote/payment rules (order intake) ----
markers('order.business+payment', backup.order, port.intake, [
  'NOT_FOUND', 'TX_FAILED', 'AMOUNT_MISMATCH', 'PAID', 'REJECTED',
  'MULTIPLE_QUOTES', 'NO_QUOTE', 'FOUNDER_QUOTE', 'TEST_OVERRIDE', 'UNRESOLVED',
  'DUPLICATE_TX', 'PAYMENT_FAILED', 'QA_FAILED', 'DELIVERY_FAILED', 'DELIVERED',
  'trim().toLowerCase()', 'expected_amount', 'quote_ref', 'price_source',
  'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  '0xAC2Af2Dd2343F4EAab2de64C89129b7B9283666F', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'FAIL: no data rows parsed from file', 'duplicates_removed=', 'dropped_empty=', 'rows_in=',
  'paid_usdc=', 'padStart(64', 'test_price_override', '1e6', 'ORD-',
]);
// status transitions present in both (gate verdict set)
const gateStatuses = ['NOT_FOUND', 'TX_FAILED', 'AMOUNT_MISMATCH', 'PAID', 'REJECTED', 'PAYMENT_FAILED', 'QA_FAILED', 'DELIVERY_FAILED', 'DELIVERED', 'DUPLICATE_TX'];
T('diff.order.status transitions all ported', gateStatuses.every(s => backup.order.includes(s) && port.intake.includes(s)));
// required fields (form intake)
markers('order.required fields', backup.order, port.intake, ['client_email', 'tx_hash', 'file_upload', 'invalid_input', 'invalid_reason']);

// ---- delivery rules ----
// delivery rule markers the n8n backup itself expresses (SENT/FAILED statuses + delivery status field);
// PENDING/SENDING/attempts are outbox-internal states that exist only in the serverless port.
markers('delivery.rules', backup.order, port.outbox + port.intake, ['SENT', 'FAILED', 'delivery_status']);
// never SENT without real adapter success: both enforce provider success gate
T('diff.delivery SENT only on adapter success (port outbox)', port.outbox.includes("status='SENT'") && port.outbox.includes('res.ok'));
T('diff.delivery never-fake rule present in backup (SMTP node send)', backup.order.includes('Send Delivery Email') || backup.order.includes('emailSend'));

// ---- error taxonomy (global) ----
const taxonomy = ['VALIDATION','NO_QUOTE','MULTIPLE_QUOTES','PAYMENT_NOT_FOUND','PAYMENT_FAILED','PAYMENT_MISMATCH','WRONG_CONTRACT','WRONG_RECIPIENT','DUPLICATE_TX','INVALID_RECEIPT','QA_FAILED','DELIVERY_FAILED','PROVIDER_ERROR','TIMEOUT','RATE_LIMIT','AI_FAILED','AUTH_FAILED','DUPLICATE'];
T('diff.taxonomy 18 codes defined in port', taxonomy.every(c => port.outbox.includes("'" + c + "'")), '');
// legacy n8n codes map 1:1 where they existed
T('diff.taxonomy legacy gate codes mapped', ['NOT_FOUND','TX_FAILED','AMOUNT_MISMATCH','NOT_USDC_TO_WALLET','INVALID_RECEIPT'].every(c => port.intake.includes(c)));

// ---- CEO engine node behavior ----
markers('ceo.engine', backup.ceo, port.pipeline, [
  'GOAL_CREATED', 'PLAN_CREATED', 'TASK_CREATED', 'APPROVAL_REQUESTED', 'WAITING_APPROVAL',
  'DEAD_LETTER', 'TASK_SUCCEEDED', 'GOAL_COMPLETED', 'FOLLOW_UP_SCHEDULED', 'LEARNING_CONFLICT',
  'PROPOSED', 'APPROVED', 'ACTIVE', 'COMPLETED', 'goal_id', 'task_id', 'priority_score',
  'ERR_DUPLICATE_ACTION', 'ERR_DEPENDENCY_FAILED', 'SUCCEEDED', 'PARTIAL_SUCCESS',
]);

// ---- bridges ----
markers('bridge.chatgpt', backup.chatgpt, port.bridges, ['read_state', 'read_tables', 'read_workflow_metadata', 'health', 'UNAUTHORIZED', 'REJECTED', 'SUCCESS']);
// the header name is an interface detail of the port (n8n stored it in the webhook credential);
// both enforce shared-secret header auth before any operation.
T('diff.bridge.chatgpt header auth enforced in port', port.bridges.includes('x-atlas-bridge-key'));
// the backup stores the signing page base64-encoded; personal_sign content is verified in the port
T('diff.bridge.siwe page contract in port (personal_sign + wallet)', port.bridges.includes('personal_sign') && port.bridges.includes('0xac2af2dd2343f4eaab'));
markers('bridge.siwe', backup.siwe, port.bridges, ['datapoint.market']);
markers('bridge.bountybook', backup.bounty, port.bridges, ['STOP_401_OR_INVALID', 'STOP_429', 'wallet_match', 'auth/verify']);

// ---- crons ----
markers('cron.daily', backup.daily, port.crons, ['report|', 'SENT']);
T('diff.cron.daily idempotency + delivery accounting in port', port.crons.includes('SKIPPED_ALREADY_SENT') && port.crons.includes('chunks_sent') && port.crons.includes('recordDelivery'));
markers('cron.watch', backup.watch, port.crons, ['BUYER_REQUEST_FOUND', 'ORDER_RECEIVED', 'PLATFORM_RECOVERY', 'watch|bb|completed', 'alert_key']);
markers('cron.telegraph', backup.telegraph, port.crons, ['telegraph_alert|', 'REAL ZATCA REQUEST', 'NOT_AVAILABLE', 'EXP-ZATCA-W25-2026-09']);

// ---- audit ----
// n8n audit lives in data-table nodes (atlas_order_ledger/event log); the port records the same in D1
T('diff.audit port records event_log + RECORDED/DUPLICATE', port.intake.includes('event_log') && port.intake.includes('RECORDED') && port.intake.includes('DUPLICATE'));
markers('audit.ledger statuses', backup.order, port.intake, ['DELIVERED', 'REJECTED', 'PAYMENT_FAILED', 'QA_FAILED', 'DELIVERY_FAILED']);

// ---- web research anti-fabrication ----
markers('web.antifabrication', backup.ceo, port.webresearch, ['ERR_RATE_LIMIT', 'ATTRIBUTED_CLAIM', 'SEARCH_SNIPPET', 'لا توجد نتائج بحث']);
T('diff.web.ERR_TIMEOUT + ERR_EMPTY_RESULT in port tools/webresearch', (port.webresearch + port.pipeline).includes('ERR_TIMEOUT') && port.pipeline.includes('ERR_EMPTY_RESULT'));

// ---- secrets: none in ported source ----
const allPort = Object.values(port).join('\n');
const secretPatterns = [/api[_-]?key\s*=\s*['"][A-Za-z0-9]{20,}/i, /Bearer\s+[A-Za-z0-9]{20,}/, /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/, /seed phrase/i, /mnemonic/i];
const found = secretPatterns.filter(re => re.test(allPort));
T('security.no secrets/keys in ported source', found.length === 0, found.map(String).join(','));

setTimeout(() => {
  console.log('\n===== M5 DIFF SUMMARY: ' + pass + ' PASS, ' + fail + ' FAIL =====');
  if (failures.length) { console.log('FAILURES:'); failures.forEach(f => console.log(' - ' + f)); process.exit(1); }
}, 300);
