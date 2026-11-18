import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const deploymentWorkflow = readFileSync('.github/workflows/atlas-clean-v1-production-deploy.yml', 'utf8');
const cleanupWorkflow = readFileSync('.github/workflows/cloudflare-clean-v1-production-cleanup.yml', 'utf8');
const activationMarker = readFileSync('ops/triggers/clean-v1-production.trigger', 'utf8');
const cleanupMarker = readFileSync('ops/triggers/clean-v1-production-cleanup.trigger', 'utf8');
const config = readFileSync('wrangler.clean-v1.toml', 'utf8');
const engine = readFileSync('src/clean-v1/engine.js', 'utf8');
const payment = readFileSync('src/clean-v1/payment.js', 'utf8');
const probe = readFileSync('ops/scripts/clean-v1-production-probe.mjs', 'utf8');
const analytics = readFileSync('ops/scripts/clean-v1-production-analytics.mjs', 'utf8');

test('production deploy is workflow_dispatch-only and has no pull-request or push trigger', () => {
  assert.match(deploymentWorkflow, /^on:\n  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(deploymentWorkflow, /^\s*(pull_request|push|schedule|workflow_run):/m);
  assert.doesNotMatch(deploymentWorkflow, /pull_request:/);
});

test('production deploy requires the exact owner marker and separate protected environment', () => {
  assert.match(deploymentWorkflow, /OWNER_CONFIRMED_CLEAN_V1_WALLET/);
  assert.match(deploymentWorkflow, /line1" = "RUN"/);
  assert.match(deploymentWorkflow, /line_count" = "3"/);
  assert.match(deploymentWorkflow, /name: clean-v1-production/);
  assert.equal(activationMarker, 'DISARMED\n');
});

test('production deploy targets only the isolated Clean v1 Wrangler config', () => {
  assert.match(config, /^name = "atlas-clean-v1"$/m);
  assert.match(config, /^main = "src\/clean-v1\/worker\.js"$/m);
  assert.match(config, /^workers_dev = false$/m);
  assert.match(config, /^preview_urls = false$/m);
  assert.doesNotMatch(config, /d1_databases|atlas_db|durable_objects|queues|routes\s*=|custom_domains/i);

  assert.equal(
    deploymentWorkflow.split("'deploy', '--config', 'wrangler.clean-v1.toml'").length - 1,
    1,
  );
  assert.ok(deploymentWorkflow.includes("spawnSync('./node_modules/.bin/wrangler', ["));
  assert.match(deploymentWorkflow, /wrangler deploy --dry-run --config wrangler\.clean-v1\.toml/);
  assert.doesNotMatch(deploymentWorkflow, /wrangler\.toml|src\/index\.ts|atlas-worker|atlas_db|d1_databases/i);
});

test('Clean v1 row bound remains 200 and approved wallet is compared to PAYMENT_CONFIG.payTo', () => {
  assert.match(engine, /^export const MAX_ROWS = 200;$/m);
  assert.match(payment, /payTo:\s*'0x[a-fA-F0-9]{40}'/);
  assert.match(deploymentWorkflow, /CLEAN_V1_APPROVED_WALLET/);
  assert.match(deploymentWorkflow, /actual\.toLowerCase\(\) !== approved\.toLowerCase\(\)/);
});

test('production token verification is read-only and never prints token or API response body', () => {
  assert.match(deploymentWorkflow, /workers\/scripts\?per_page=1/);
  assert.match(deploymentWorkflow, /api\.cloudflare\.com\/client\/v4\/graphql/);
  assert.match(deploymentWorkflow, /CF_TOKEN_WORKERS_SCRIPTS_READ=PASS/);
  assert.match(deploymentWorkflow, /CF_TOKEN_WORKERS_ANALYTICS_READ/);
  assert.doesNotMatch(deploymentWorkflow, /console\.log\((?:token|payload|JSON\.stringify\(payload)/i);
  assert.doesNotMatch(deploymentWorkflow, /wrangler (?:delete|rollback|secret put)|-X DELETE|method:\s*'DELETE'/i);
});

test('post-deploy probe checks GET and 10/200 preview rows plus unpaid 402 without payment', () => {
  assert.match(probe, /method:\s*'GET'/);
  assert.match(probe, /method:\s*'POST'/);
  assert.match(probe, /cleanV1ProductionCsv\(rowCount\)/);
  assert.match(probe, /checkPostPreview\(base, 10/);
  assert.match(probe, /checkPostPreview\(base, 200/);
  assert.match(probe, /status, 402/);
  assert.match(probe, /PAYMENT-REQUIRED/);
  assert.doesNotMatch(probe, /['"]PAYMENT-SIGNATURE['"]\\s*:/i);
  assert.doesNotMatch(probe, /['"]authorization['"]\\s*:/i);
  assert.doesNotMatch(probe, /facilitatorFetch|\\/settle/i);
});

test('Analytics helper queries the exact production Worker and reports CPU unit, statuses, and resource overruns', () => {
  assert.match(analytics, /scriptName:\s*"atlas-clean-v1"/);
  assert.match(analytics, /cpuTimeP50/);
  assert.match(analytics, /cpuTimeP99/);
  assert.match(analytics, /CPU_QUANTILE_UNIT=/);
  assert.match(analytics, /INVOCATION_STATUS_COUNTS=/);
  assert.match(analytics, /HTTP_RESPONSE_STATUS_COUNTS=/);
  assert.match(analytics, /RESOURCE_OVERRUN_REQUESTS=/);
  assert.match(analytics, /exceeded\(resources\|cpu\)/i);
  assert.match(deploymentWorkflow, /sleep 300/);
});

test('production cleanup is separately manual, marker-gated, and targets only atlas-clean-v1', () => {
  assert.match(cleanupWorkflow, /^on:\n  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(cleanupWorkflow, /^\s*(push|pull_request|schedule|workflow_run):/m);
  assert.match(cleanupWorkflow, /OWNER_CONFIRMED_STOP_CLEAN_V1_PRODUCTION/);
  assert.match(cleanupWorkflow, /const target = 'atlas-clean-v1'/);
  assert.match(cleanupWorkflow, /method,\s*path/);
  assert.match(cleanupWorkflow, /'DELETE'/);
  assert.doesNotMatch(cleanupWorkflow, /atlas-clean-v1-trial|atlas-worker|wrangler\.toml|atlas_db|d1_databases/i);
  assert.equal(cleanupMarker, 'DISARMED\n');
});
