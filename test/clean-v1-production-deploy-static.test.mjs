import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');

const deployWorkflow = read('.github/workflows/atlas-clean-v1-production-deploy.yml');
const stopWorkflow = read('.github/workflows/atlas-clean-v1-production-stop.yml');
const trialCleanupWorkflow = read('.github/workflows/cloudflare-clean-v1-cleanup.yml');
const config = read('wrangler.clean-v1.toml');
const engine = read('src/clean-v1/engine.js');
const payment = read('src/clean-v1/payment.js');
const deployMarker = read('ops/triggers/clean-v1-production.trigger');
const stopMarker = read('ops/triggers/clean-v1-production-stop.trigger');

test('production deploy workflow is manual or exact main trigger-marker push only', () => {
  assert.match(deployWorkflow, /^  workflow_dispatch:/m);
  assert.match(deployWorkflow, /^  push:/m);
  assert.match(deployWorkflow, /branches: \[main\]/);
  assert.match(deployWorkflow, /paths:\n\s+- "ops\/triggers\/clean-v1-production\.trigger"/);
  assert.doesNotMatch(deployWorkflow, /^  pull_request\s*:/m);
  assert.doesNotMatch(deployWorkflow, /^  schedule\s*:/m);
  assert.match(deployWorkflow, /lines\.length === 1 && lines\[0\] === 'PREFLIGHT'/);
  assert.match(deployWorkflow, /lines\[0\] === 'RUN'/);
  assert.match(deployWorkflow, /lines\[1\] === 'OWNER_CONFIRMED_CLEAN_V1_WALLET'/);
  assert.match(deployWorkflow, /lines\[2\] === ''/);
  assert.match(deployWorkflow, /let mode = 'skip'/);
  assert.match(deployWorkflow, /outputs:\s*\n\s*mode:/);
  assert.match(deployWorkflow, /needs\.resolve-trigger\.outputs\.mode == 'preflight'/);
  assert.match(deployWorkflow, /needs\.resolve-trigger\.outputs\.mode == 'deploy'/);
  assert.match(deployWorkflow, /needs: \[resolve-trigger, read-only-preflight\]/);
});

test('production deployment commands use only the dedicated Clean v1 config', () => {
  const deployCommands = deployWorkflow
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^run: npx --no-install wrangler deploy(?: --|$)/.test(line));
  assert.deepEqual(deployCommands, [
    'run: npx --no-install wrangler deploy --dry-run --config wrangler.clean-v1.toml',
    'run: npx --no-install wrangler deploy --config wrangler.clean-v1.toml',
  ]);
  assert.equal(/^name = "atlas-clean-v1"$/m.test(config), true);
  assert.equal(/^main = "src\/clean-v1\/worker.js"$/m.test(config), true);
  assert.match(config, /^workers_dev = true$/m);
  assert.match(config, /^preview_urls = false$/m);
  assert.doesNotMatch(config, /d1_databases|atlas_db|routes\s*=|custom_domains/i);
  assert.match(deployWorkflow, /const expected = 'https:\/\/atlas-clean-v1\.hosamhosaam5\.workers\.dev';/);
  assert.match(deployWorkflow, /if \(base !== expected\)/);
  assert.doesNotMatch(deployWorkflow, /wrangler\.toml(?!$)/);
  assert.doesNotMatch(deployWorkflow, /atlas-worker/);
});

const approvedDeployMarkers = new Set([
  'DISARMED\n',
  'PREFLIGHT\n',
  'RUN\nOWNER_CONFIRMED_CLEAN_V1_WALLET\n\n',
]);

function resolveDeployMarker(rawInput) {
  const raw = rawInput.replace(/\r\n/g, '\n');
  const content = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const lines = content.split('\n');
  if (lines.length === 1 && lines[0] === 'PREFLIGHT') return 'preflight';
  if (lines.length === 3 && lines[0] === 'RUN' && lines[1] === 'OWNER_CONFIRMED_CLEAN_V1_WALLET' && lines[2] === '') return 'deploy';
  return 'skip';
}

test('production trigger matches exactly one approved marker state and RUN requires exact wallet confirmation', () => {
  assert.equal(approvedDeployMarkers.has(deployMarker), true);
  assert.match(deployWorkflow, /lines\[0\] === 'RUN'/);
  assert.match(deployWorkflow, /lines\[1\] === 'OWNER_CONFIRMED_CLEAN_V1_WALLET'/);
  assert.match(deployWorkflow, /lines\[2\] === ''/);
  assert.match(deployWorkflow, /lines\.length === 3/);
  assert.match(deployWorkflow, /CLEAN_V1_PROD_BASE_URL/);
  assert.match(deployWorkflow, /needs: \[resolve-trigger, read-only-preflight\]/);
  assert.match(deployWorkflow, /needs\.resolve-trigger\.outputs\.mode == 'deploy'/);
});

test('production marker parser mirrors the workflow trimming and split logic', () => {
  assert.ok(deployWorkflow.includes("const content = raw.endsWith('\\n') ? raw.slice(0, -1) : raw;"));
  assert.equal(resolveDeployMarker('PREFLIGHT\n'), 'preflight');
  assert.equal(resolveDeployMarker('RUN\nOWNER_CONFIRMED_CLEAN_V1_WALLET\n\n'), 'deploy');
  assert.equal(resolveDeployMarker('DISARMED\n'), 'skip');
  assert.equal(resolveDeployMarker('RUN\n'), 'skip');
  assert.equal(resolveDeployMarker('RUN\nOWNER_CONFIRMED_CLEAN_V1_WALLET\n'), 'skip');
  assert.equal(resolveDeployMarker('preflight\n'), 'skip');
});

test('production trigger rejects incomplete or incorrectly cased marker values', () => {
  for (const invalidMarker of ['RUN\n', 'RUN\nOWNER_CONFIRMED_CLEAN_V1_WALLET\n', 'preflight\n']) {
    assert.equal(approvedDeployMarkers.has(invalidMarker), false);
  }
});

test('preview and unpaid-payment checks are present without a real payment path', () => {
  const probe = read('ops/scripts/clean-v1-production-probe.mjs');
  assert.match(probe, /\/x402\/clean_v1\/preview\?format=csv/);
  assert.match(probe, /csvRows\(10\)/);
  assert.match(probe, /csvRows\(200\)/);
  assert.match(probe, /\/x402\/clean_v1'/);
  assert.match(probe, /unpaid\.status, 402/);
  assert.match(probe, /PAYMENT-REQUIRED/);
  assert.match(probe, /REAL_PAYMENT_SENT=false/);
  assert.match(probe, /service, 'atlas-clean-v1'/);
  assert.match(deployWorkflow, /sleep 300/);
  const analytics = read('ops/scripts/clean-v1-production-analytics.mjs');
  assert.match(analytics, /cpuTimeP50/);
  assert.match(analytics, /cpuTimeP99/);
  assert.match(analytics, /RESOURCE_OVERRUN_STATUSES/);
  assert.match(analytics, /INVOCATION_STATUS_COUNTS/);
});

test('read-only preflight uses only the existing token and reports write scope as UNKNOWN', () => {
  const preflight = read('ops/scripts/clean-v1-production-preflight.mjs');
  assert.match(deployWorkflow, /secrets\.CF_TRIAL_API_TOKEN/);
  assert.doesNotMatch(deployWorkflow, /secrets\.CF_CLEAN_V1_PROD_API_TOKEN/);
  assert.match(preflight, /\/user\/tokens\/verify/);
  assert.match(preflight, /workers\/scripts/);
  assert.match(preflight, /Account Analytics: Read/);
  assert.match(preflight, /WORKER_DEPLOY_WRITE_PERMISSION=UNKNOWN/);
  assert.match(preflight, /Workers Editor/);
  assert.match(preflight, /Workers product Admin/);
  assert.doesNotMatch(preflight, /console\.log\(token/);
});

test('production stop is workflow_dispatch-only, marker-gated, and rollback-only', () => {
  assert.match(stopWorkflow, /^\s*workflow_dispatch:/m);
  assert.doesNotMatch(stopWorkflow, /^\s*pull_request\s*:/m);
  assert.doesNotMatch(stopWorkflow, /^\s*push\s*:/m);
  assert.doesNotMatch(stopWorkflow, /^\s*schedule\s*:/m);
  assert.match(stopWorkflow, /OWNER_CONFIRMED_CLEAN_V1_ROLLBACK/);
  assert.match(stopWorkflow, /lines\[2\] === ''/);
  assert.match(stopWorkflow, /wrangler rollback/);
  assert.match(stopWorkflow, /--name atlas-clean-v1 --config wrangler\.clean-v1\.toml/);
  assert.doesNotMatch(stopWorkflow, /wrangler delete|DELETE /i);
  assert.equal(stopMarker, 'DISARMED\n');
});

test('existing automatic cleanup remains restricted to the trial Worker', () => {
  assert.match(trialCleanupWorkflow, /ops\/triggers\/clean-v1-cleanup\.trigger/);
  assert.match(trialCleanupWorkflow, /atlas-clean-v1-trial/);
  assert.doesNotMatch(trialCleanupWorkflow, /['"]atlas-clean-v1['"]/);
  assert.match(trialCleanupWorkflow, /^\s*workflow_dispatch:/m);
});

test('row cap remains 200 and receiving wallet source remains payment configuration', () => {
  assert.match(engine, /^export const MAX_ROWS = 200;$/m);
  assert.match(payment, /payTo:\s*'0x[0-9a-fA-F]{40}'/);
  assert.match(payment, /payTo:\s*'0x59Ea688b36464133E71873d8BeE8Fcb3BC369383'/);
  assert.match(payment, /paymentFlow: 'upfront'/);
});
