import { verifyMessage } from 'ethers';

// BOUNTYBOOK AUTH — ported from backup workflow "ATLAS — BountyBook Session Auth" (76ZfJNYW8fONf9kl).
// Same contract: GET /bridge/bountybook → same HTML form; POST /bridge/bountybook → verify via
// Provider Adapter (BOUNTYBOOK_PROVIDER=MOCK default, zero real API calls) → same JSON response
// shape: {auth, wallet_match, stop, message}. Session token is never logged or returned.

export const EXPECTED_WALLET = '0xAC2Af2Dd2343F4EAab2de64C89129b7B9283666F';

// Ported verbatim from backup "Serve Form" node.
const FORM_HTML = (nonce) => '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ATLAS BountyBook</title></head><body><div><h1>ATLAS — BountyBook Session Unlock</h1><p>Sign this exact fresh nonce with MetaMask using personal_sign. The nonce expires in 5 minutes and is single-use.</p><form method="POST" action="/bridge/bountybook"><label>Fresh nonce</label><input name="nonce" type="text" value="' + String(nonce).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '" readonly required><label>EIP-191 signature</label><input name="signature" type="password" autocomplete="off" required><button type="submit">VERIFY</button></form></div></body></html>';

// Provider Adapter for api.bountybook.ai.
export function getBountyBookProvider(env) {
  const mode = (env.BOUNTYBOOK_PROVIDER || 'MOCK').toUpperCase();
  if (mode === 'MOCK') {
    const scenario = env.BOUNTYBOOK_MOCK_SCENARIO || 'ok';
    return {
      async getNonce(address) { return makeNonce(); },
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
    async getNonce(address) {
      const res = await fetch('https://api.bountybook.ai/auth/nonce?address=' + encodeURIComponent(address), { method: 'GET', signal: AbortSignal.timeout(15000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.nonce) throw new Error('BountyBook nonce request failed: HTTP ' + res.status);
      return String(data.nonce);
    },
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

export async function ensureBountyBookNonceSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS bountybook_auth_nonces (nonce TEXT PRIMARY KEY, wallet TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)`).bind().run();
}
export function makeNonce() { const bytes = new Uint8Array(24); crypto.getRandomValues(bytes); return 'atlas-bb-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
export async function issueNonce(db, provider) {
  await ensureBountyBookNonceSchema(db);
  const nonce = provider ? await provider.getNonce(EXPECTED_WALLET) : makeNonce(); const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await db.prepare('INSERT INTO bountybook_auth_nonces (nonce, wallet, expires_at) VALUES (?, ?, ?)').bind(nonce, EXPECTED_WALLET.toLowerCase(), expires).run();
  return nonce;
}
export async function consumeNonce(db, nonce) {
  await ensureBountyBookNonceSchema(db);
  const row = await db.prepare('SELECT nonce, wallet, expires_at, used_at FROM bountybook_auth_nonces WHERE nonce = ?').bind(nonce).first();
  if (!row) return { ok: false, reason: 'NONCE_UNKNOWN' };
  if (row.used_at) return { ok: false, reason: 'NONCE_REPLAY' };
  if (Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: 'NONCE_EXPIRED' };
  const upd = await db.prepare("UPDATE bountybook_auth_nonces SET used_at=datetime('now') WHERE nonce=? AND used_at IS NULL AND expires_at > datetime('now')").bind(nonce).run();
  const changed = upd.meta && (upd.meta.changes !== undefined ? upd.meta.changes : upd.meta.rows_written) || 0;
  return changed === 1 ? { ok: true, wallet: row.wallet } : { ok: false, reason: 'NONCE_REPLAY' };
}
function failResponse(status, stop, message) { return new Response(JSON.stringify({ auth: 'FAILED', wallet_match: 'UNVERIFIED', stop, message }), { status, headers: { 'content-type': 'application/json' } }); }
export async function handleBountyBookAuth(request, env) {
  if (!env.DB) return failResponse(503, 'AUTH_STORAGE_UNAVAILABLE', 'Auth nonce storage is unavailable.');
  if (request.method === 'GET') {
    try { const nonce = await issueNonce(env.DB); return new Response(FORM_HTML(nonce), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }); }
    catch { return failResponse(503, 'AUTH_STORAGE_UNAVAILABLE', 'Could not issue a fresh nonce.'); }
  }
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let nonce = '', signature = '';
  const ct = request.headers.get('content-type') || '';
  try {
    if (ct.includes('application/json')) {
      const j = await request.json();
      nonce = String(j?.nonce || '').trim();
      signature = String(j?.signature || '').trim();
    } else {
      const fd = await request.formData();
      nonce = String(fd.get('nonce') || '').trim();
      signature = String(fd.get('signature') || '').trim();
    }
  } catch { return failResponse(400, 'INVALID_INPUT', 'Could not parse nonce and signature.'); }
  if (!nonce || !signature) return failResponse(400, 'INVALID_INPUT', 'nonce and signature are required.');
  let recovered;
  try { recovered = await verifyMessage(nonce, signature); } catch { return failResponse(401, 'INVALID_SIGNATURE', 'Signature is invalid. No provider request executed.'); }
  if (recovered.toLowerCase() !== EXPECTED_WALLET.toLowerCase()) return failResponse(401, 'WRONG_WALLET', 'Signature does not recover to the pinned ATLAS wallet. No provider request executed.');
  const claim = await consumeNonce(env.DB, nonce);
  if (!claim.ok) return failResponse(401, claim.reason, 'Nonce is invalid, expired, or already used. No provider request executed.');
  const provider = getBountyBookProvider(env); let gate;
  try { gate = sessionGate(await provider.authVerify(EXPECTED_WALLET, signature)); } catch (e) { gate = sessionGate({ error: String(e?.message || e) }); }
  let report = gate;
  if (gate.auth === 'SUCCESS') {
    try {
      // The local EIP-191 recovery already proves control of the pinned wallet. For LIVE,
      // do not depend on an undocumented profile endpoint; the provider's /auth/verify
      // is the session authority and returned a token only after accepting this nonce/signature.
      const conf = (String(env.BOUNTYBOOK_PROVIDER || 'MOCK').toUpperCase() === 'LIVE')
        ? { address: EXPECTED_WALLET }
        : await provider.confirmSession(EXPECTED_WALLET, gate.session_token);
      report = authReport(gate, conf);
    } catch { report = { auth: 'FAILED', wallet_match: 'UNVERIFIED', stop_condition: 'STOP_CONFIRM_FAILED', message: 'Session confirm failed. No claim/submit executed.' }; }
  }
  const body = { auth: report.auth, wallet_match: report.wallet_match, stop: report.stop_condition || '', message: report.message || '' };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
