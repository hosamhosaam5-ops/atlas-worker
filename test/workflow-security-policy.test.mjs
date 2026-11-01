import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const workflowDir = new URL('../.github/workflows/', import.meta.url);
const workflowFiles = (await readdir(workflowDir)).filter((name) => /\.ya?ml$/i.test(name));

test('PR-triggered workflows do not receive secrets or touch live production', async () => {
  const findings = [];
  for (const name of workflowFiles) {
    const content = await readFile(new URL('../.github/workflows/' + name, import.meta.url), 'utf8');
    const hasPullRequest = /^  pull_request(?:_target)?:/m.test(content);
    const hasSecrets = /\$\{\{\s*secrets\./.test(content);
    const hasProductionD1 = /wrangler\s+d1\s+(?:export|execute|info)\s+atlas_db\s+--remote/i.test(content);
    const hasLiveWorker = /https:\/\/atlas-worker\.hosamhosaam5\.workers\.dev\//i.test(content);
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
    const hasSecrets = /\$\{\{\s*secrets\./.test(content);
    const hasManualTrigger = /^  workflow_dispatch:/m.test(content);
    if (!hasSecrets || !hasManualTrigger) continue;
    const hasMainGuard = /if:\s*.*github\.ref\s*==\s*['"]refs\/heads\/main['"]/.test(content) ||
      /github\.event\.workflow_run\.head_branch\s*==\s*['"]main['"]/.test(content);
    if (!hasMainGuard) findings.push(name);
  }
  assert.deepEqual(findings, [], 'manual secret-bearing jobs must be main-only');
});
