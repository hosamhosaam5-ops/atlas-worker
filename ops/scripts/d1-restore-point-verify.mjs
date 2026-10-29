import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

(async () => {
const summary = process.env.GITHUB_STEP_SUMMARY;
const result = spawnSync('npx', ['--no-install', 'wrangler', 'd1', 'info', 'atlas_db'], {
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 8 * 1024 * 1024,
});
if (result.status !== 0) {
  const exact = String(result.stderr || result.stdout || result.error?.message || 'wrangler d1 info failed').trim();
  fs.appendFileSync(summary, '## D1 credential verification: FAILED\n\n```text\n' + exact + '\n```\n');
  process.exit(21);
}
const token = process.env.CLOUDFLARE_API_TOKEN;
const whoami = spawnSync('npx', ['--no-install', 'wrangler', 'whoami', '--json'], {
  encoding: 'utf8', env: process.env, maxBuffer: 8 * 1024 * 1024,
});
if (whoami.status !== 0) throw new Error('Wrangler account identity lookup failed; refusing ambiguous account selection.');
const identityText = String(whoami.stdout || '').trim();
const jsonStart = identityText.indexOf('{');
if (jsonStart < 0) throw new Error('Wrangler returned no account identity JSON.');
const identity = JSON.parse(identityText.slice(jsonStart));
const accounts = Array.isArray(identity.accounts) ? identity.accounts : (Array.isArray(identity.result?.accounts) ? identity.result.accounts : []);
if (accounts.length !== 1) throw new Error('Expected exactly one accessible Cloudflare account; refusing ambiguous account selection.');
const account = String(accounts[0]?.id || '');
if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error('Wrangler returned no valid account identifier.');
const api = async (path) => {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  const data = await response.json();
  if (!response.ok || data.success !== true) {
    const details = Array.isArray(data.errors) ? data.errors.map(x => x.message).join('; ') : '';
    throw new Error('Cloudflare API HTTP ' + response.status + (details ? ': ' + details : ''));
  }
  return data.result;
};
let version = '';
try {
  const listed = await api('/accounts/' + account + '/d1/database?name=atlas_db&per_page=100');
  const db = Array.isArray(listed) ? listed.find(x => x.name === 'atlas_db') : null;
  if (!db?.uuid) throw new Error('Exact database atlas_db was not returned by the D1 list endpoint.');
  const details = await api('/accounts/' + account + '/d1/database/' + db.uuid + '?fields=uuid,name,version');
  version = details?.version || '';
} catch (e) {
  fs.appendFileSync(summary, '## D1 backend verification: FAILED\n\n' + String(e.message || e) + '\n');
  process.exit(23);
}
if (version !== 'production') {
  fs.appendFileSync(summary, '## D1 backend verification: FAILED\n\nExpected D1 version=production; observed version=' + (version || 'unknown') + '. Time Travel support is not proven.\n');
  process.exit(23);
}
fs.appendFileSync(summary, '## D1 credential and backend verification\n\n- Wrangler D1 info: **PASS**\n- Cloudflare D1 API backend version: **production**\n');
})().catch((error) => { console.error(error); process.exit(1); });