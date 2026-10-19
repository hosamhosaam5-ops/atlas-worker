// Email provider adapter. MOCK is the safe default; RESEND requires explicit
// configuration and reports success only when Resend returns a valid message ID.
// This adapter deliberately does not retry: retrying a timed-out POST can duplicate mail.

export function getEmailProvider(env = {}) {
  const kind = String(env.EMAIL_PROVIDER || 'MOCK').trim().toUpperCase();

  if (kind === 'MOCK') {
    const scenario = env.EMAIL_MOCK_SCENARIO || 'success';
    return {
      kind,
      async send(msg = {}) {
        if (!isValidEmail(msg.to)) return { ok: false, error: 'invalid recipient' };
        if (scenario === 'fail') {
          return { ok: false, error: 'mock smtp failure (ENETUNREACH equivalent)' };
        }
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
      async send(msg = {}) {
        // Fail closed before any network request. Never send with missing credentials.
        const apiKey = typeof env.RESEND_API_KEY === 'string' ? env.RESEND_API_KEY.trim() : '';
        const from = typeof env.EMAIL_FROM === 'string' ? env.EMAIL_FROM.trim() : '';
        if (!apiKey) return { ok: false, error: 'resend configuration missing RESEND_API_KEY' };
        if (!from) return { ok: false, error: 'resend configuration missing EMAIL_FROM' };
        if (!isValidEmail(msg.to)) return { ok: false, error: 'invalid recipient' };
        if (typeof msg.subject !== 'string' || !msg.subject.trim()) {
          return { ok: false, error: 'invalid subject' };
        }
        if (typeof msg.text !== 'string') return { ok: false, error: 'invalid message text' };

        let attachments;
        try {
          attachments = (msg.attachments || []).map((a) => {
            if (!a || typeof a.file_name !== 'string' || !a.file_name.trim()) {
              throw new Error('invalid attachment filename');
            }
            return { filename: a.file_name, content: base64FromBytes(a.bytes) };
          });
        } catch {
          return { ok: false, error: 'invalid attachment' };
        }

        let res;
        try {
          res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + apiKey,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              from,
              to: [msg.to.trim()],
              subject: msg.subject,
              text: msg.text,
              ...(attachments.length ? { attachments } : {}),
            }),
            signal: AbortSignal.timeout(15000),
          });
        } catch {
          // Do not automatically retry an uncertain POST: it could already have been accepted.
          return { ok: false, code: 'DELIVERY_UNCERTAIN', error: 'resend network error or timeout; delivery status uncertain; manual reconciliation required' };
        }

        if (!res.ok) {
          const uncertain = res.status === 408 || res.status >= 500;
          return { ok: false, ...(uncertain ? { code: 'DELIVERY_UNCERTAIN' } : {}), error: 'resend http ' + res.status + (uncertain ? '; delivery status uncertain; manual reconciliation required' : '') };
        }

        let body;
        try {
          body = await res.json();
        } catch {
          return { ok: false, code: 'DELIVERY_UNCERTAIN', error: 'resend returned invalid JSON; delivery status uncertain; manual reconciliation required' };
        }
        if (!body || typeof body.id !== 'string' || !body.id.trim()) {
          return { ok: false, code: 'DELIVERY_UNCERTAIN', error: 'resend response missing message ID; delivery status uncertain; manual reconciliation required' };
        }
        return { ok: true, provider_message_id: body.id };
      },
    };
  }

  throw new Error('unknown EMAIL_PROVIDER: ' + kind);
}

function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const email = value.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function base64FromBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('attachment bytes must be a Uint8Array');
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
