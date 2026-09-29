// SIWE SIGNING BRIDGE — ported from backup workflow "ATLAS — SIWE Signing Bridge" (iDjBzf1OKLZ0Hh5H).
// Same contract: GET /bridge/siwe → fetch fresh SIWE challenge (Provider Adapter) → serve
// the same HTML signing page (personal_sign only, expected wallet enforced client-side).
// DATAPOINT_PROVIDER=MOCK by default — zero real API calls.

export const EXPECTED_WALLET = '0xAC2Af2Dd2343F4EAab2de64C89129b7B9283666F';

// The HTML template is ported verbatim from the backup "Build Signing Page" node
// (base64-decoded). __MSG_JS__ is replaced with the JSON-quoted SIWE message.
const TPL = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ATLAS SIWE Signing Bridge</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;background:#0f1115;color:#e8e8e8;max-width:640px;margin:0 auto;padding:20px}
pre{background:#1a1d24;padding:14px;border-radius:8px;white-space:pre-wrap;word-break:break-word;font-size:13px;border:1px solid #2a2e38}
button{background:#037dd6;color:#fff;border:0;border-radius:8px;padding:14px 22px;font-size:16px;width:100%;margin-top:14px}
textarea{width:100%;height:120px;background:#1a1d24;color:#8f8;border:1px solid #2a2e38;border-radius:8px;font-size:12px;padding:10px;box-sizing:border-box}
.ok{color:#6f6}.err{color:#f66}.muted{color:#888;font-size:12px}
</style></head><body>
<h3>ATLAS — datapoint.market SIWE Signing Bridge</h3>
<p class="muted">Signs ONLY this message via personal_sign (EIP-191). No transaction, no contract, no gas, no key access. Open this page inside the MetaMask app's built-in browser.</p>
<p class="muted">Expected wallet: <b>0xAC2Af2Dd2343F4EAab2de64C89129b7B9283666F</b></p>
<pre id="m"></pre>
<button id="b">Connect &amp; Sign (personal_sign only)</button>
<p id="s" class="muted"></p>
<textarea id="sig" placeholder="The signature will appear here — copy it and send it to ATLAS" readonly style="display:none"></textarea>
<script>
const MSG = __MSG_JS__;
document.getElementById('m').textContent = MSG;
const EXPECTED = '0xac2af2dd2343f4eaab2de64c89129b7b9283666f';
const st = document.getElementById('s');
document.getElementById('b').onclick = async () => {
  try {
    if (!window.ethereum) { st.className='err'; st.textContent='No injected wallet. Open this page inside the MetaMask app browser.'; return; }
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const acct = (accounts[0]||'').toLowerCase();
    if (acct !== EXPECTED) { st.className='err'; st.textContent='Wrong account selected: '+acct+' — switch MetaMask to 0xAC2A...3666F and retry.'; return; }
    st.className=''; st.textContent='Connected: '+acct+' — requesting personal_sign...';
    const hex = '0x' + Array.from(new TextEncoder().encode(MSG)).map(b=>b.toString(16).padStart(2,'0')).join('');
    const sig = await window.ethereum.request({ method: 'personal_sign', params: [hex, acct] });
    document.getElementById('sig').style.display='block';
    document.getElementById('sig').value = sig;
    st.className='ok'; st.textContent='Signed. Copy the signature below and send it to ATLAS. Nothing was sent anywhere except this display.';
  } catch (e) { st.className='err'; st.textContent='Error: '+(e && e.message ? e.message : e); }
};
</script>
</body></html>
`;

// Provider Adapter for the datapoint challenge endpoint.
// MOCK: deterministic challenge, no network. LIVE (never used in M3): real POST.
export function getDatapointProvider(env) {
  const mode = (env.DATAPOINT_PROVIDER || 'MOCK').toUpperCase();
  if (mode === 'MOCK') {
    const scenario = env.DATAPOINT_MOCK_SCENARIO || 'ok';
    return {
      async fetchChallenge() {
        if (scenario === 'fail') throw new Error('MOCK datapoint provider failure');
        if (scenario === 'no_message') return {};
        const nonce = 'mock-' + Date.now().toString(36);
        return {
          message: [
            'datapoint.market wants you to sign in with your Ethereum account:',
            EXPECTED_WALLET,
            '',
            'Sign in to datapoint.market (MOCK challenge — no real request was made).',
            '',
            'URI: https://api.datapoint.market',
            'Version: 1',
            'Chain ID: 8453',
            'Nonce: ' + nonce,
            'Issued At: ' + new Date().toISOString()
          ].join('\n')
        };
      }
    };
  }
  // LIVE scaffold — unused in M3 (no credentials, no network).
  return {
    async fetchChallenge() {
      const res = await fetch('https://api.datapoint.market/auth/wallet/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: EXPECTED_WALLET, network: 'eip155:8453' }),
        signal: AbortSignal.timeout(15000),
      });
      return res.json();
    }
  };
}

// Ported from backup "Build Signing Page": missing message is a hard error (never fake a page).
export function buildSigningPage(challenge) {
  const msg = challenge && challenge.message;
  if (!msg) throw new Error('no SIWE message from datapoint');
  const msgJs = JSON.stringify(msg);
  return TPL.replace('__MSG_JS__', msgJs);
}

export async function handleSiweBridge(request, env) {
  if (request.method !== 'GET') {
    return new Response('method not allowed', { status: 405 });
  }
  const provider = getDatapointProvider(env);
  let html;
  try {
    const challenge = await provider.fetchChallenge();
    html = buildSigningPage(challenge);
  } catch (e) {
    return new Response('SIWE challenge unavailable: ' + (e && e.message ? e.message : e), { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
