import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import worker from '../src/data-cleaning/worker.js';

const TOKEN = 'diagnostic-only-secret-value-0123456789-abcdef';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const CHUNK_BYTES = 48 * 1024;
const evidence = {
  suite: 'local POST /v1/jobs diagnostics',
  cloudflareNetworkAccess: false,
  cases: [],
  exceptionPaths: [],
  healthyRuns: [],
};

function makeCsv(rowCount) {
  const lines = ['id,value'];
  for (let index = 1; index <= rowCount; index++) {
    lines.push(index + ',synthetic-' + index);
  }
  return lines.join('\n') + '\n';
}

function makeRequest(options = {}) {
  const rows = options.rows ?? 1;
  const token = Object.prototype.hasOwnProperty.call(options, 'token') ? options.token : TOKEN;
  const headers = {
    'content-type': 'text/csv; charset=utf-8',
    'x-atlas-cleaning-options': JSON.stringify({
      inputFormat: 'csv',
      outputFormat: 'json',
      delimiter: ',',
      chunkRows: 250,
      operations: [{ type: 'convert_format', to: 'json' }],
    }),
  };
  if (token !== null) headers.authorization = 'Bearer ' + token;
  return new Request('https://local-worker.test/v1/jobs', {
    method: 'POST',
    headers,
    body: makeCsv(rows),
  });
}

function makeEnv(options = {}) {
  const sentBatches = [];
  const configuredToken = Object.prototype.hasOwnProperty.call(options, 'configuredToken')
    ? options.configuredToken
    : TOKEN;
  const env = {
    CLEANING_API_TOKEN: configuredToken,
    CLEANING_RATE_LIMIT_PER_MINUTE: '10',
    JOB_STATE: {
      idFromName(name) { return name; },
      get() {
        return {
          async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === '/init') {
              if (options.jobInitThrows) throw new Error('mock JobState transport failure token=' + TOKEN + ' account=' + ACCOUNT_ID);
              return new Response('{}', { status: options.jobInitStatus ?? 200 });
            }
            if (path === '/fail') return new Response('{}', { status: 200 });
            return new Response('{}', { status: 200 });
          },
        };
      },
    },
    ATLAS_CLEANING_QUEUE: {
      async sendBatch(messages) {
        if (options.queueFailure) {
          throw new Error('mock Queue failure token=' + TOKEN + ' account=' + ACCOUNT_ID);
        }
        sentBatches.push(messages.length);
      },
    },
  };
  if (!options.rateLimiterMissing) {
    env.RATE_LIMITER = {
      idFromName(name) { return name; },
      get() {
        return {
          async fetch() {
            if (options.rateThrows) throw new Error('mock RateLimit DO transport failure token=' + TOKEN + ' account=' + ACCOUNT_ID);
            return new Response('{"allowed":true}', { status: options.rateStatus ?? 200 });
          },
        };
      },
    };
  }
  return { env, sentBatches };
}

function assertNoSecrets(value, logs) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(serialized.includes(TOKEN), false, 'API token must not appear in response or evidence');
  assert.equal(serialized.includes(ACCOUNT_ID), false, 'account identifier must not appear in response or evidence');
  for (const line of logs) {
    assert.equal(line.includes(TOKEN), false, 'API token must not appear in captured logs');
    assert.equal(line.includes(ACCOUNT_ID), false, 'account identifier must not appear in captured logs');
  }
}

test('POST /v1/jobs returns stable 503 codes and accepts healthy synthetic sizes without leaking secrets', async () => {
  const capturedLogs = [];
  const originalConsole = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    originalConsole[method] = console[method];
    console[method] = (...args) => capturedLogs.push(args.map(String).join(' '));
  }

  async function checkFailure(name, envOptions, requestOptions, expectedCode) {
    const { env } = makeEnv(envOptions);
    const response = await worker.fetch(makeRequest(requestOptions), env);
    const body = await response.json();
    assert.equal(response.status, 503, name + ' status');
    assert.equal(body.error, expectedCode, name + ' error code');
    assertNoSecrets(body, capturedLogs);
    evidence.cases.push({ name, status: response.status, body });
  }

  async function recordUnhandledException(name, envOptions) {
    const { env } = makeEnv(envOptions);
    let thrown;
    try {
      await worker.fetch(makeRequest(), env);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error, name + ' should surface a rejected DO fetch');
    const observation = {
      name,
      outcome: 'uncaught_exception_without_http_response',
      status: null,
      body: null,
      errorName: thrown.name,
    };
    assertNoSecrets(observation, capturedLogs);
    evidence.exceptionPaths.push(observation);
  }

  try {
    await checkFailure(
      'CLEANING_API_TOKEN missing',
      { configuredToken: null },
      { token: null },
      'AUTH_NOT_CONFIGURED',
    );
    await checkFailure(
      'CLEANING_API_TOKEN shorter than 32',
      { configuredToken: 'short-token' },
      { token: 'short-token' },
      'AUTH_NOT_CONFIGURED',
    );
    await checkFailure(
      'RATE_LIMITER missing',
      { rateLimiterMissing: true },
      {},
      'RATE_LIMITER_NOT_CONFIGURED',
    );
    await checkFailure(
      'RateLimit DO returns non-OK',
      { rateStatus: 503 },
      {},
      'RATE_LIMIT_CHECK_FAILED',
    );
    await checkFailure(
      'JobState initialization returns non-OK',
      { jobInitStatus: 500 },
      {},
      'JOB_INITIALIZATION_FAILED',
    );
    await checkFailure(
      'Queue sendBatch throws a token-bearing mock error',
      { queueFailure: true },
      {},
      'QUEUE_SUBMISSION_FAILED',
    );

    await recordUnhandledException('RateLimit DO fetch rejects instead of returning an HTTP response', { rateThrows: true });
    await recordUnhandledException('JobState init fetch rejects instead of returning an HTTP response', { jobInitThrows: true });

    for (const rowCount of [100, 2000, 10000]) {
      const { env, sentBatches } = makeEnv();
      const response = await worker.fetch(makeRequest({ rows: rowCount }), env);
      const body = await response.json();
      assert.equal(response.status, 202, rowCount + '-row submission status');
      assert.equal(body.status, 'queued', rowCount + '-row submission state');
      assert.match(body.jobId, /^[0-9a-f-]{36}$/i);
      const inputBytes = Buffer.byteLength(makeCsv(rowCount));
      const expectedChunks = Math.max(1, Math.ceil(inputBytes / CHUNK_BYTES));
      assert.equal(body.chunks, expectedChunks);
      assert.equal(sentBatches.reduce((sum, size) => sum + size, 0), expectedChunks);
      assertNoSecrets(body, capturedLogs);
      evidence.healthyRuns.push({
        rows: rowCount,
        status: response.status,
        body,
        inputBytes,
        queueBatchSizes: sentBatches,
      });
    }

    const workflow = await readFile(resolve('.github/workflows/cloudflare-trial-deploy.yml'), 'utf8');
    assert.match(workflow, /function redactDiagnosticText/);
    assert.match(workflow, /created\.text\(\)/);
    assert.match(workflow, /created\.statusText/);
    assert.match(workflow, /created\.headers\.get\('cf-ray'\)/);
    assert.match(workflow, /created\.headers\.get\('content-type'\)/);
    assert.match(workflow, /UPLOAD_BODY_REDACTED/);
    assert.match(workflow, /UPLOAD_EXCEPTION_STACK/);
    assert.match(workflow, /UPLOAD_ERROR_FIELD/);
    assert.match(workflow, /Preflight CLEANING_API_TOKEN length before synthetic upload/);
    assert.match(workflow, /-ge 32/);
    const helperStart = workflow.indexOf('function redactDiagnosticText(');
    const helperEnd = workflow.indexOf('async function measure(', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart, 'workflow redaction helper must be present');
    const redactDiagnosticText = runInNewContext('(' + workflow.slice(helperStart, helperEnd).trim() + ')');
    const redactionFixture = JSON.stringify({
      error: 'QUEUE_SUBMISSION_FAILED',
      token: TOKEN,
      account_id: ACCOUNT_ID,
      email: 'synthetic@example.test',
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    });
    const redactedFixture = redactDiagnosticText(redactionFixture, [TOKEN]);
    assert.equal(redactedFixture.includes(TOKEN), false);
    assert.equal(redactedFixture.includes(ACCOUNT_ID), false);
    assert.equal(redactedFixture.includes('synthetic@example.test'), false);
    assert.equal(redactedFixture.includes('abcdefghijklmnopqrstuvwxyz0123456789'), false);
    assert.ok(redactedFixture.includes('QUEUE_SUBMISSION_FAILED'), 'stable error code must remain visible');
    evidence.workflowChecks = {
      responseStatusAndText: true,
      allowedHeadersOnly: ['cf-ray', 'content-type'],
      fullSanitizedBody: true,
      exceptionStack: true,
      separateErrorAndCodeFields: true,
      tokenLengthPreflight: true,
    };

    assertNoSecrets(evidence, capturedLogs);
    evidence.logSafety = {
      capturedApplicationLogLines: capturedLogs.length,
      tokenAbsent: true,
      accountIdentifierAbsent: true,
    };
  } finally {
    for (const method of Object.keys(originalConsole)) console[method] = originalConsole[method];
    await mkdir(resolve('artifacts'), { recursive: true });
    await writeFile(
      resolve('artifacts/data-cleaning-v1-diagnostics.json'),
      JSON.stringify(evidence, null, 2) + '\n',
      'utf8',
    );
  }
});
