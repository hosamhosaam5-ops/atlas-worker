import test from 'node:test';
import assert from 'node:assert/strict';
import { sendDnsExitSmtp } from '../src/orders/dnsexit-smtp.js';

function fakeConnect({ startTls = true } = {}) {
  const state = { controller: null, inData: false, tls: false, writes: [] };
  const makeSocket = (isTls = false) => {
    const readable = new ReadableStream({
      start(controller) {
        state.controller = controller;
        if (!isTls) controller.enqueue(new TextEncoder().encode('220 relay ready\r\n'));
      },
    });
    return {
      readable,
      writable: new WritableStream({
        write(chunk) {
          const text = new TextDecoder().decode(chunk);
          state.writes.push(text);
          if (state.inData) {
            if (text.includes('\r\n.\r\n') || text.endsWith('\r\n.\r\n')) {
              state.inData = false;
              state.controller.enqueue(new TextEncoder().encode('250 queued as test-id\r\n'));
            }
            return;
          }
          const cmd = text.trim();
          let response = '';
          if (cmd.startsWith('EHLO')) response = startTls && !state.tls
            ? '250-relay.example\r\n250-PIPELINING\r\n250 STARTTLS\r\n'
            : '250-relay.example\r\n250 AUTH LOGIN\r\n';
          else if (cmd === 'STARTTLS') response = '220 begin tls\r\n';
          else if (cmd === 'AUTH LOGIN') response = '334 VXNlcm5hbWU6\r\n';
          else if (cmd === btoa('smtp-user')) response = '334 UGFzc3dvcmQ6\r\n';
          else if (cmd === btoa('smtp-pass')) response = '235 authenticated\r\n';
          else if (cmd.startsWith('MAIL FROM:')) response = '250 sender ok\r\n';
          else if (cmd.startsWith('RCPT TO:')) response = '250 recipient ok\r\n';
          else if (cmd === 'DATA') { response = '354 send data\r\n'; state.inData = true; }
          else if (cmd === 'QUIT') response = '221 bye\r\n';
          else response = '500 unexpected command\r\n';
          state.controller.enqueue(new TextEncoder().encode(response));
        },
      }),
      opened: Promise.resolve({}),
      async close() {},
      startTls() { state.tls = true; return makeSocket(true); },
    };
  };
  return {
    state,
    connect(address, options) {
      assert.equal(address.hostname, 'relay.dnsexit.com');
      assert.equal(address.port, 587);
      assert.equal(options.secureTransport, 'starttls');
      return makeSocket(false);
    },
  };
}

const env = {
  DNS_EXIT_SMTP_USERNAME: 'smtp-user',
  DNS_EXIT_SMTP_PASSWORD: 'smtp-pass',
  EMAIL_FROM: 'sender@atlas-agent.work.gd',
};

test('DNSExit SMTP uses STARTTLS and returns success only after SMTP DATA acceptance', async () => {
  const fake = fakeConnect();
  const id = await sendDnsExitSmtp(env, {
    to: 'recipient@example.com',
    subject: 'ATLAS test',
    text: 'hello',
  }, fake.connect);
  assert.match(id, /^dnsexit-/);
  assert.equal(fake.state.tls, true);
  assert.ok(fake.state.writes.some((x) => x.includes('AUTH LOGIN')));
  assert.ok(fake.state.writes.some((x) => x.includes('MAIL FROM:<sender@atlas-agent.work.gd>')));
  assert.ok(fake.state.writes.some((x) => x.includes('Subject: ATLAS test')));
});

test('DNSExit SMTP fails closed when credentials or sender are missing', async () => {
  await assert.rejects(() => sendDnsExitSmtp({}, { to: 'recipient@example.com', text: 'x' }, fakeConnect().connect), /not configured/);
});

test('DNSExit SMTP rejects header injection before opening a connection', async () => {
  let called = false;
  const connect = () => { called = true; throw new Error('should not connect'); };
  await assert.rejects(() => sendDnsExitSmtp({ ...env }, {
    to: 'recipient@example.com',
    subject: 'hello\r\nBcc: victim@example.com',
    text: 'x',
  }, connect), /invalid email headers/);
  assert.equal(called, false);
});

test('DNSExit SMTP refuses servers that do not advertise STARTTLS', async () => {
  const fake = fakeConnect({ startTls: false });
  await assert.rejects(() => sendDnsExitSmtp(env, {
    to: 'recipient@example.com',
    subject: 'ATLAS test',
    text: 'hello',
  }, fake.connect), /does not offer STARTTLS/);
});
