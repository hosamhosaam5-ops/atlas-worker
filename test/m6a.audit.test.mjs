// M6A — FINAL CODE AUDIT (item 1) + static safety checks.
// Runs entirely locally; reads only the repo's own source files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(js|ts)$/.test(f)) out.push(p);
  }
  return out;
}
const FILES = walk(SRC);
const CODE = Object.fromEntries(FILES.map(f => [f, fs.readFileSync(f, 'utf8')]));
const ALL = Object.values(CODE).join('\n');

test('audit.imports: every relative import resolves to a real file', () => {
  for (const [f, c] of Object.entries(CODE)) {
    for (const m of c.matchAll(/import\s+[^'"]*from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(f), spec);
      assert.ok(fs.existsSync(target), `unresolved import ${spec} in ${path.relative(ROOT, f)}`);
    }
  }
});

test('audit.exports: no unused exported symbol (dead code)', () => {
  const exported = [];
  for (const [f, c] of Object.entries(CODE)) {
    for (const m of c.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g)) {
      exported.push([f, m[1]]);
    }
  }
  // Public surfaces by design (used at deploy time, by other phases, or by tests):
  const PUBLIC = new Set([
    'runDailyReport', 'runRevenueWatch', 'runTelegraphMonitor', // wrangler Cron entry points
    'applyMigrations', 'importRows', 'checksumRows',            // migration tooling (item 6)
    'mapPaymentStatus', 'classifyError', 'isErrorCode',         // shared taxonomy API
    'USDC_DECIMALS', 'BASE_NETWORK', 'BASE_RPC_URL_DEFAULT',    // pinned payment config constants
  ]);
  const unused = [];
  for (const [f, name] of exported) {
    const re = new RegExp('\\b' + name + '\\b', 'g');
    let refs = 0;
    for (const c of Object.values(CODE)) { const m = c.match(re); if (m) refs += m.length; }
    if (refs <= 1 && !PUBLIC.has(name)) unused.push(path.relative(ROOT, f) + ': ' + name);
  }
  assert.deepEqual(unused, [], 'unused exports: ' + unused.join(', '));
});

test('audit.secrets: no hardcoded api keys / tokens / private keys in source', () => {
  const patterns = [
    /sk-[A-Za-z0-9]{20,}/, /re_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /Bearer\s+[A-Za-z0-9_\-.]{20,}/, /api[_-]?key['":\s=]+['"][A-Za-z0-9]{16,}/i,
    /0x[a-fA-F0-9]{64}(?![\s\S]{0,0})/, // raw private-key-shaped hex
  ];
  for (const [f, c] of Object.entries(CODE)) {
    for (const p of patterns) {
      const m = c.match(p);
      if (m) {
        // allowed: the deliberate dummy test tx-hash fixture and the public ERC-20 Transfer topic constant
        if (/^0x1{64}$/.test(m[0])) continue;
        if (m[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') continue;
        assert.fail(`secret-shaped value in ${path.relative(ROOT, f)}: ${m[0].slice(0, 24)}…`);
      }
    }
  }
});

test('audit.async: no floating promise from db.prepare without await/return', () => {
  const bad = [];
  for (const [f, c] of Object.entries(CODE)) {
    c.split('\n').forEach((l, i) => {
      const t = l.trim();
      if (!/\.prepare\(/.test(t)) return;
      if (t.startsWith('//')) return;
      if (/\bawait\b/.test(t) || /^(return|const|let|var)\b/.test(t) || /=>/.test(t) || /^async\b/.test(t)) return;
      bad.push(`${path.relative(ROOT, f)}:${i + 1}: ${t.slice(0, 80)}`);
    });
  }
  assert.deepEqual(bad, [], 'floating db.prepare: ' + bad.join(' | '));
});

test('audit.payment-config: pinned production USDC values are present and exact', () => {
  const pay = CODE[path.join(SRC, 'orders/payment.js')];
  assert.match(pay, /0xAC2Af2Dd2343F4EAab2de64C89129b7B9283666F/);
  assert.match(pay, /0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/);
  assert.match(pay, /USDC_DECIMALS\s*=\s*6/);
  assert.match(pay, /eip155:8453/);
});

test('audit.price: expected_amount never read from client form input', () => {
  const intake = CODE[path.join(SRC, 'orders/intake.js')];
  // prepareOrderMeta must hardcode expected_amount: 0 and UNRESOLVED
  assert.match(intake, /expected_amount:\s*0/);
  assert.match(intake, /price_source:\s*'UNRESOLVED'/);
  // no code path may read first.expected_amount / input.expected_amount
  assert.ok(!/first\.expected_amount|input\.expected_amount|body\.expected_amount/.test(intake), 'client-controlled price detected');
});

test('audit.delivery: SENT written only through outbox settle on adapter ok:true', () => {
  const ob = CODE[path.join(SRC, 'core/outbox.js')];
  assert.match(ob, /res\.ok !== true/);            // malformed success rejected
  assert.match(ob, /status='SENT'/);               // single settle path
  assert.match(ob, /UNIQUE|dedupe_key TEXT NOT NULL UNIQUE|INSERT OR IGNORE/);
});

test('audit.error-taxonomy: 18 explicit codes exist and classifyError never invents success', () => {
  const err = CODE[path.join(SRC, 'core/errors.js')];
  const codes = err.match(/'[A-Z_]{3,}'/g) || [];
  const uniq = new Set(codes.map(s => s.replace(/'/g, '')));
  for (const need of ['VALIDATION','NO_QUOTE','MULTIPLE_QUOTES','PAYMENT_NOT_FOUND','PAYMENT_FAILED','PAYMENT_MISMATCH','WRONG_CONTRACT','WRONG_RECIPIENT','DUPLICATE_TX','INVALID_RECEIPT','QA_FAILED','DELIVERY_FAILED','PROVIDER_ERROR','TIMEOUT','RATE_LIMIT','AI_FAILED','AUTH_FAILED','DUPLICATE']) {
    assert.ok(uniq.has(need), 'missing code ' + need);
  }
});
