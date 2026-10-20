// Email provider adapter. MOCK remains the default and never sends real mail.
import { sendDnsExitSmtp } from './dnsexit-smtp.js';

export function getEmailProvider(env) {
  const kind = env.EMAIL_PROVIDER || 'MOCK';
  if (kind === 'MOCK') {
    const scenario = env.EMAIL_MOCK_SCENARIO || 'success';
    return {
      kind,
      async send(msg) {
        if (!msg.to || !msg.to.includes('@')) return { ok: false, error: 'invalid recipient' };
        if (scenario === 'fail') return { ok: false, error: 'mock smtp failure (ENETUNREACH equivalent)' };
        if (scenario === 'flaky') {
          this.__calls = (this.__calls || 0) + 1;
          if (this.__calls === 1) return { ok: false, error: 'transient mock failure' };
        }
        return { ok: true, provider_message_id: 'mock-' + Date.now() };
      },
    };
  }
  if (kind === 'RESEND') {
    return {
      kind,
      async send(msg) {
        if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { ok: false, error: 'resend provider is not configured' };
        try {
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
            body: JSON.stringify({
              from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text,
              attachments: (msg.attachments || []).map(a => ({
                filename: a.file_name, content: base64FromBytes(a.bytes),
              })),
            }),
          });
          if (!res.ok) return { ok: false, error: 'resend http ' + res.status };
          const body = await res.json();
          return body?.id ? { ok: true, provider_message_id: body.id } : { ok: false, error: 'resend response missing message id' };
        } catch { return { ok: false, error: 'resend request failed' }; }
      },
    };
  }
  if (kind === 'DNSEXIT_SMTP') {
    return {
      kind,
      async send(msg) {
        try {
          const id = await sendDnsExitSmtp(env, msg);
          return { ok: true, provider_message_id: id };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'smtp transport failed' };
        }
      },
    };
  }
  throw new Error('unknown EMAIL_PROVIDER: ' + kind);
}

function base64FromBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let bin = '';
  for (let i = 0; i < view.length; i += 0x8000) bin += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(bin);
}
