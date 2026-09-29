// BOUNTYBOOK AUTH — ported from backup workflow "ATLAS — BountyBook Session Auth" (76ZfJNYW8fONf9kl).
// Same contract: GET /bridge/bountybook → same HTML form; POST /bridge/bountybook → verify via
// Provider Adapter (BOUNTYBOOK_PROVIDER=MOCK default, zero real API calls) → same JSON response
// shape: {auth, wallet_match, stop, message}. Session token is never logged or returned.

export const EXPECTED_WALLET = '0xAC2Af2Dd2343F4EAab2de64C89129b7B9283666F';

// Ported verbatim from backup "Serve Form" node.
const FORM_HTML = '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ATLAS BountyBook</title><style>body{font-family:system-ui;background:#0f1115;color:#e7e9ee;display:flex;justify-content:center;padding:40px 16px}.card{background:#181b22;border:1px solid #2a2e38;border-radius:14px;padding:28px;max-width:560px;width:100%}h1{font-size:20px;margin:0 0 8px}p{color:#9aa0ab;font-size:13px}label{display:block;font-size:13px;margin:14px 0 6px;color:#b9bfc9}input{width:100%;box-sizing:border-box;padding:11px;border-radius:8px;border:1px solid #343945;background:#0f1115;color:#e7e9ee;font-family:monospace;font-size:13px}button{margin-top:22px;width:100%;padding:12px;border:0;border-radius:9px;background:#4f7cff;color:#fff;font-size:15px;font-weight:600;cursor:pointer}</style></head><body><div class="card"><h1>ATLAS — BountyBook Session Unlock</h1><p>Sign the nonce in MetaMask (personal_sign), paste it + the signature, press VERIFY. Signature is used once, never stored, never shown.</p><form method="POST" action="/bridge/bountybook" enctype="application/x-www-form-urlencoded"><label>Fresh nonce</label><input name="nonce" type="text" autocomplete="off" spellcheck="false" required><label>EIP-191 signature (0x...)</label><input name="signature" type="password" autocomplete="off" spellcheck="false" required><button type="submit">VERIFY</button></form></div></body></html>';

// Provider Adapter for api.bountybook.ai.
export function getBountyBookProvider(env) {
  const mode = (env.BOUNTYBOOK_PROVIDER || 'MOCK').toUpperCase();
  if (mode === 'MOCK') {
    const scenario = env.BOUNTYBOOK_MOCK_SCENARIO || 'ok';
    return {
      async authVerify(address, signature) {
        if (scenario === 'fail_401') return { error: 'invalid signature' };
        if (scenario === 'fail_429') return { error: 'HTTP 429 rate limit' };
        if (scenario === 'network_fail') throw new Error('MOCK network failure');
        return { token: 'mock-session-token', expiresAt: new Date(Date.now() + 3600e3).toISOString() };
      },
      async confirmSession(address, token) {
        if (scenario === 'wrong_wallet') return { address: '0x0000000000000000000000000000000000000000' };
        return { address: address };
      }
    };
  }
  // LIVE scaffold — unused in M3.
  return {
    async authVerify(address, signature) {
      const res = await fetch('https://api.bountybook.ai/auth/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, signature }),
      });
      return res.json().catch(() => ({}));
    },
    async confirmSession(address, token) {
      const res = await fetch('https://api.bountybook.ai/agents/' + address, {
        headers: { Authorization: 'Bearer ' + token },
      });
      return res.json().catch(() => ({}));
    }
  };
}

// Ported from backup "Session Gate" code node.
export function sessionGate(res) {
  const token = res && res.token;
  if (!token) {
    const err = (res && (res.error || res.message)) || 'unknown';
    const stop = String(err).includes('429') ? 'STOP_429' : 'STOP_401_OR_INVALID';
    return { auth: 'FAILED', stop_condition: stop, wallet_match: 'UNVERIFIED', message: 'Auth failed. No claim/submit executed.', error_from_server: err };
  }
  return { auth: 'SUCCESS', session_token: token, expiresAt: res.expiresAt || null, wallet_match: 'PENDING_CONFIRM' };
}

// Ported from backup "Auth Report" code node.
export function authReport(gate, conf) {
  if (gate.auth !== 'SUCCESS') return gate;
  const ok = conf && conf.address && String(conf.address).toLowerCase() === EXPECTED_WALLET.toLowerCase();
  return { auth: ok ? 'SUCCESS' : 'FAILED', session_token: gate.session_token, expiresAt: gate.expiresAt, wallet_match: ok ? 'YES' : 'NO', message: 'SESSION ACTIVE. Ready for jobs. NO claim executed.' };
}

export async function handleBountyBookAuth(request, env) {
  if (request.method === 'GET') {
    return new Response(FORM_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  let signature = '';
  try {
    const fd = await request.formData();
    signature = String(fd.get('signature') || '').trim();
  } catch (e) {
    try { const j = await request.json(); signature = String((j && j.signature) || '').trim(); } catch (e2) { signature = ''; }
  }

  // LIVE auth is disabled until nonce/challenge verification and replay protection
  // are implemented against a documented provider contract. No live request is sent.
  if ((env.BOUNTYBOOK_PROVIDER || 'MOCK').toUpperCase() === 'LIVE') {
    return new Response(JSON.stringify({ auth: 'FAILED', wallet_match: 'UNVERIFIED', stop: 'LIVE_AUTH_NOT_HARDENED', message: 'Live BountyBook auth disabled pending nonce/signature verification and replay protection. No provider request or claim executed.' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }

  const provider = getBountyBookProvider(env);
  let gate;
  try {
    const verifyRes = await provider.authVerify(EXPECTED_WALLET, signature);
    gate = sessionGate(verifyRes);
  } catch (e) {
    gate = sessionGate({ error: String(e && e.message || e) });
  }
  let report = gate;
  if (gate.auth === 'SUCCESS') {
    try {
      const conf = await provider.confirmSession(EXPECTED_WALLET, gate.session_token);
      report = authReport(gate, conf);
    } catch (e) {
      report = { auth: 'FAILED', wallet_match: 'UNVERIFIED', stop_condition: 'STOP_CONFIRM_FAILED', message: 'Session confirm failed. No claim/submit executed.' };
    }
  }
  // Same response shape as backup "Respond Result" node — token never included.
  const body = {
    auth: report.auth,
    wallet_match: report.wallet_match,
    stop: report.stop_condition || '',
    message: report.message || ''
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
