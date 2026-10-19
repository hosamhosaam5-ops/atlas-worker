import test from 'node:test';
import assert from 'node:assert/strict';
import { getEmailProvider } from '../src/orders/email.js';

const validMessage = {
  to: 'recipient@example.com',
  subject: 'ATLAS test',
  text: 'This is a test.',
};

function withFetch(fakeFetch, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return Promise.resolve()
    .then(run)
    .finally(() => { globalThis.fetch = original; });
}

test('MOCK is default and does not make network requests', async () => {
  await withFetch(() => { throw new Error('network must not be called'); }, async () => {
    const provider = getEmailProvider({});
    assert.equal(provider.kind, 'MOCK');
    const result = await provider.send(validMessage);
    assert.equal(result.ok, true);
    assert.match(result.provider_message_id, /^mock-/);
  });
});

test('RESEND fails closed when API key or sender is missing', async () => {
  await withFetch(() => { throw new Error('network must not be called'); }, async () => {
    assert.match((await getEmailProvider({ EMAIL_PROVIDER: 'RESEND' }).send(validMessage)).error, /RESEND_API_KEY/);
    assert.match((await getEmailProvider({ EMAIL_PROVIDER: 'RESEND', RESEND_API_KEY: 'test' }).send(validMessage)).error, /EMAIL_FROM/);
  });
});

test('RESEND validates recipient and message before network request', async () => {
  await withFetch(() => { throw new Error('network must not be called'); }, async () => {
    const provider = getEmailProvider({ EMAIL_PROVIDER: 'RESEND', RESEND_API_KEY: 'test', EMAIL_FROM: 'sender@example.com' });
    assert.equal((await provider.send({ ...validMessage, to: 'not-an-email' })).ok, false);
    assert.equal((await provider.send({ ...validMessage, subject: ' ' })).ok, false);
    assert.equal((await provider.send({ ...validMessage, text: undefined })).ok, false);
  });
});

test('RESEND returns success only for a valid accepted message ID and encodes attachments', async () => {
  await withFetch(async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.from, 'ATLAS <sender@example.com>');
    assert.deepEqual(body.to, ['recipient@example.com']);
    assert.deepEqual(body.attachments, [{ filename: 'data.csv', content: 'YSxiCg==' }]);
    return new Response(JSON.stringify({ id: 're_test_123' }), { status: 200 });
  }, async () => {
    const provider = getEmailProvider({
      EMAIL_PROVIDER: 'RESEND',
      RESEND_API_KEY: 'test-key',
      EMAIL_FROM: 'ATLAS <sender@example.com>',
    });
    const result = await provider.send({
      ...validMessage,
      attachments: [{ file_name: 'data.csv', bytes: new TextEncoder().encode('a,b\n') }],
    });
    assert.deepEqual(result, { ok: true, provider_message_id: 're_test_123' });
  });
});

test('RESEND maps HTTP errors to failure and never retries', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 });
  }, async () => {
    const provider = getEmailProvider({ EMAIL_PROVIDER: 'RESEND', RESEND_API_KEY: 'test', EMAIL_FROM: 'sender@example.com' });
    const result = await provider.send(validMessage);
    assert.deepEqual(result, { ok: false, error: 'resend http 429' });
    assert.equal(calls, 1);
  });
});

test('RESEND fails closed for malformed success responses', async () => {
  const provider = getEmailProvider({ EMAIL_PROVIDER: 'RESEND', RESEND_API_KEY: 'test', EMAIL_FROM: 'sender@example.com' });
  await withFetch(async () => new Response('not-json', { status: 200 }), async () => {
    assert.match((await provider.send(validMessage)).error, /invalid JSON/);
  });
  await withFetch(async () => new Response(JSON.stringify({}), { status: 200 }), async () => {
    assert.match((await provider.send(validMessage)).error, /missing message ID/);
  });
});

test('RESEND catches network errors without unsafe automatic retries', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    throw new Error('simulated network failure');
  }, async () => {
    const provider = getEmailProvider({ EMAIL_PROVIDER: 'RESEND', RESEND_API_KEY: 'test', EMAIL_FROM: 'sender@example.com' });
    const result = await provider.send(validMessage);
    assert.equal(result.ok, false);
    assert.match(result.error, /delivery status uncertain/);
    assert.equal(calls, 1);
  });
});

test('unknown providers are rejected explicitly', () => {
  assert.throws(() => getEmailProvider({ EMAIL_PROVIDER: 'SMTP' }), /unknown EMAIL_PROVIDER/);
});
