import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const workflowDir = new URL('../.github/workflows/', import.meta.url);
const workflowFiles = (await readdir(workflowDir)).filter((name) => /\\.ya?ml$/i.test(name));

test('PR-triggered workflows do not receive secrets or touch live production', async () => {
  const findings = [];
  for (const name of workflowFiles) {
    const content = await readFile(new URL('../.github/workflows/' + name, import.meta.url), 'utf8');
    const hasPullRequest = /^  pull_request(?:_target)?:/m.test(content);
    const hasSecrets = /\\$\\{\\{\\s*secrets\\./.test(content);
    const hasProductionD1 = /wrangler\\s+d1\\s+(?:export|execute|info)\\s+atlas_db\\s+--remote/i.test(content);
    const hasLiveWorker = /https:\\/\\/atlas-worker\\.hosamhosaam5\\.workers\\.dev\\//i.test(content);
    if (hasPullRequest && (hasSecrets || hasProductionD1 || hasLiveWorker)) {
      findings.push(name);
    }
  }
  assert.deepEqual(findings, [], 'production/secret workflows must not run from pull_request or pull_request_target');
});

test('secret-bearing workflow_dispatch jobs are restricted to main', async () => {
  const findings = [];
  for (const name of workflowFiles) {
    const content = await readFile(new URL('../.github/workflows/' + name, import.meta.url), 'utf8');
    const hasSecrets = /\\$\\{\\{\\s*secrets\\./.test(content);
    const hasManualTrigger = /^  workflow_dispatch:/m.test(content);
    if (!hasSecrets || !hasManualTrigger) continue;
    const hasMainGuard = /if:\\s*.*github\\.ref\\s*==\\s*['"]refs\\/heads\\/main['"]/.test(content) ||
      /github\\.event\\.workflow_run\\.head_branch\\s*==\\s*['"]main['"]/.test(content);
    if (!hasMainGuard) findings.push(name);
  }
  assert.deepEqual(findings, [], 'manual secret-bearing jobs must be main-only');
});

test('Registry submission cannot be triggered by an ordinary main push', async () => {
  const workflow = await readFile(new URL('../.github/workflows/atlas-tests.yml', import.meta.url), 'utf8');
  const registryJob = workflow.match(/^  registry_submit:\\n((?:^(?:    |\\s*$).*\\n?)*)/m)?.[1] ?? '';
  const executableRegistryJob = registryJob
    .split('\\n')
    .filter((line) => !/^\\s*#/.test(line))
    .join('\\n');
  assert.match(executableRegistryJob, /^\\s+if: github\\.event_name == 'workflow_dispatch' && github\\.ref == 'refs\\/heads\\/main'$/m);
  const dedicated = await readFile(new URL('../.github/workflows/atlas-registry-submit.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(dedicated.split('permissions:')[0], /\\.github\\/workflows\\/atlas-registry-submit\\.yml/);
});
