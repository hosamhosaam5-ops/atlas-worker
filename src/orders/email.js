// M4 Email Provider Adapter — EMAIL_PROVIDER=MOCK (default). Designed so Resend (or any
// HTTPS mail API) can be added in M5 by implementing the same { send } contract without
// touching Order Intake core. NO real email is ever sent in MOCK.
//
// Contract: send({to, subject, text, attachments:[{file_name, bytes}]})
//   -> { ok: true, provider_message_id } | { ok: false, error }
// A provider must return ok:true ONLY on real acceptance by the mail API. Order Intake
// records SENT only when ok===true — never on absence of an exception.

export function getEmailProvider(env) {
  const kind = env.EMAIL_PROVIDER || 'MOCK';
  if (kind === 'MOCK') {
    const scenario = env.EMAIL_MOCK_SCENARIO || 'success';
    return {
      kind,
      async send(msg) {
        if (!msg.to || !msg.to.includes('@')) {
          return { ok: false, error: 'invalid recipient' };
        }
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
    // M5 scaffold — requires founder approval + account + secret. Not used in M4.
    return {
      kind,
      async send(msg) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text,
            attachments: (msg.attachments || []).map(a => ({
              filename: a.file_name,
              content: base64FromBytes(a.bytes),
            })),
          }),
        });
        if (!res.ok) return { ok: false, error: 'resend http ' + res.status };
        const body = await res.json();
        return { ok: true, provider_message_id: body.id };
      },
    };
  }
  throw new Error('unknown EMAIL_PROVIDER: ' + kind);
}

function base64FromBytes(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
