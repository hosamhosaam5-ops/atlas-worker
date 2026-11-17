import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { runCleanV1TrialProbe } from '../ops/scripts/clean-v1-trial-probe.mjs';

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test('same Clean v1 readiness, 10/200-row, and unpaid-402 probe passes on wrangler dev --local', async () => {
  const port = await unusedPort();
  const childEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  // Deliberately remove all Cloudflare credentials: this is a local-only runtime test.
  delete childEnv.CF_TRIAL_API_TOKEN;
  delete childEnv.CLOUDFLARE_API_TOKEN;
  delete childEnv.CLOUDFLARE_ACCOUNT_ID;

  const child = spawn('./node_modules/.bin/wrangler', [
    'dev',
    '--local',
    '--config',
    'wrangler.clean-v1-trial.toml',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--inspector-port',
    '0',
  ], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    const result = await runCleanV1TrialProbe('http://127.0.0.1:' + port);
    assert.equal(result.previews[0].sourceRows, 10);
    assert.equal(result.previews[0].returnedRows, 10);
    assert.equal(result.previews[1].sourceRows, 200);
    assert.equal(result.previews[1].returnedRows, 10);
    assert.equal(result.unpaid402.status, 402);
    assert.equal(result.unpaid402.code, 'PAYMENT_REQUIRED');
    assert.equal(result.readinessStatus, 415);
  } catch (error) {
    const tail = output.split('\n').slice(-30).join('\n');
    throw new Error((error?.stack || String(error)) + '\n--- wrangler dev --local output (tail) ---\n' + tail);
  } finally {
    await stopProcess(child);
  }
});
