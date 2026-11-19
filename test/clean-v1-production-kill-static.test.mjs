import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const killWorkflow = read('.github/workflows/atlas-clean-v1-production-kill.yml');
const killMarker = read('ops/triggers/clean-v1-production-kill.trigger');

function resolveKillMarker(raw) {
  const lines = raw.split('\n');
  return lines.length === 3 &&
    lines[0] === 'KILL' &&
    lines[1] === 'OWNER_CONFIRMED_CLEAN_V1_KILL' &&
    lines[2] === ''
    ? 'kill'
    : 'skip';
}

function assertWorkerAllowlist(name) {
  if (name === 'atlas-worker') throw new Error('Refusing forbidden Worker name atlas-worker');
  if (name !== 'atlas-clean-v1') throw new Error('Worker name is not allowlisted');
}

test('kill workflow is push-only on the exact main marker path', () => {
  const onStart = killWorkflow.indexOf('\non:\n') + 1;
  const triggers = killWorkflow.slice(onStart, killWorkflow.indexOf('\npermissions:'));
  assert.match(triggers, /^on:\n  push:\n    branches: \[main\]/);
  assert.match(triggers, /      - "ops\/triggers\/clean-v1-production-kill\.trigger"/);
  assert.doesNotMatch(triggers, /pull_request|schedule|workflow_dispatch/);
});

test('only exact owner-confirmed KILL marker arms the action; DISARMED and malformed values skip', () => {
  assert.equal(killMarker, 'DISARMED\n');
  assert.match(killWorkflow, /lines\.length === 3/);
  assert.match(killWorkflow, /lines\[0\] === 'KILL'/);
  assert.match(killWorkflow, /lines\[1\] === 'OWNER_CONFIRMED_CLEAN_V1_KILL'/);
  assert.match(killWorkflow, /lines\[2\] === ''/);
  assert.equal(resolveKillMarker('KILL\nOWNER_CONFIRMED_CLEAN_V1_KILL\n'), 'kill');
  for (const invalid of ['DISARMED\n', 'KILL\n', 'KILL\nOWNER_CONFIRMED_CLEAN_V1_KILL', 'KILL\nOWNER_CONFIRMED_CLEAN_V1_KILL\nextra\n']) {
    assert.equal(resolveKillMarker(invalid), 'skip');
  }
});

test('kill operation is restricted to atlas-clean-v1 and explicitly rejects atlas-worker', () => {
  assert.match(killWorkflow, /const targetWorkerName = 'atlas-clean-v1'/);
  assert.match(killWorkflow, /const forbiddenWorkerName = 'atlas-worker'/);
  assert.match(killWorkflow, /name === forbiddenWorkerName/);
  assert.match(killWorkflow, /name !== 'atlas-clean-v1'/);
  assert.throws(() => assertWorkerAllowlist('atlas-worker'), /Refusing forbidden Worker name/);
  assert.throws(() => assertWorkerAllowlist('some-other-worker'), /not allowlisted/);
  assert.doesNotThrow(() => assertWorkerAllowlist('atlas-clean-v1'));
  assert.match(killWorkflow, /method: 'DELETE'/);
  assert.ok(killWorkflow.includes("'/workers/scripts/' + encodeURIComponent(targetWorkerName)"));
  assert.match(killWorkflow, /item\.id === targetWorkerName/);
  assert.doesNotMatch(killWorkflow, /force[=:]|delete-with-references/i);
});

test('kill workflow uses only the existing token and verifies Worker absence through a separate read', () => {
  assert.match(killWorkflow, /secrets\.CF_TRIAL_API_TOKEN/);
  assert.doesNotMatch(killWorkflow, /secrets\.(?!CF_TRIAL_API_TOKEN)/);
  assert.match(killWorkflow, /const after = await listTargetWorkers\(\)/);
  assert.match(killWorkflow, /workerPresent=/);
  assert.match(killWorkflow, /WORKER_DELETE_VERIFIED=true/);
  assert.match(killWorkflow, /WORKER_DELETE_RESPONSE_RAW=/);
  assert.match(killWorkflow, /WORKER_TARGET_POST_DELETE_RAW=/);
  assert.match(killWorkflow, /WORKER_SCRIPTS_LIST_RAW=/);
});

test('kill workflow cannot touch D1, atlas_db, or the shared Wrangler config', () => {
  assert.doesNotMatch(killWorkflow, /d1_databases|atlas_db|wrangler\.toml/i);
  assert.match(killWorkflow, /const targetWorkerName = 'atlas-clean-v1'/);
  assert.match(killWorkflow, /Refusing forbidden Worker name atlas-worker/);
});
