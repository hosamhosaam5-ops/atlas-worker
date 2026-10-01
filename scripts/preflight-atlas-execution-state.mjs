// M6A — FAIL-CLOSED execution-state migration preflight.
// This tool is intentionally READ-ONLY: it never writes to D1.
// It validates the exported n8n atlas_execution_state CSV before any production import.

import fs from 'node:fs';
import crypto from 'node:crypto';

const EXPECTED = Object.freeze({
  sourceRows: 281,
  keyedRows: 267,
  uniqueKeys: 266,
  missingKeyRows: 14,
  duplicateKey: 'req|2arj8z',
  checksum: '96f47d6dfcfbffaf',
});

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text ?? '').replace(/^\\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\\r') field += c;
  }
  if (quoted) throw new Error('unterminated CSV quote');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function readExecutionStateCsv(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (!rows.length) throw new Error('empty CSV');
  const header = rows.shift();
  if (!header.includes('idempotency_key')) throw new Error('missing idempotency_key column');
  return rows.filter(r => !(r.length === 1 && r[0] === '')).map(r =>
    Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))
  );
}

export function checksumRows(rows) {
  const canon = rows.map(r => JSON.stringify(
    Object.keys(r).sort().reduce((o, k) => { o[k] = r[k]; return o; }, {})
  )).sort();
  return crypto.createHash('sha256').update(canon.join('\\n')).digest('hex').slice(0, 16);
}

export function preflightExecutionState(rows, expected = EXPECTED) {
  const keys = rows.map(r => r.idempotency_key).filter(Boolean);
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const duplicateKeys = [...counts.entries()].filter(([, count]) => count > 1);
  const missingKeyRows = rows.filter(r => !r.idempotency_key);
  const report = {
    sourceRows: rows.length,
    keyedRows: keys.length,
    uniqueKeys: new Set(keys).size,
    missingKeyRows: missingKeyRows.length,
    duplicateKeys,
    checksum: checksumRows(rows),
  };
  const exactShape = report.sourceRows === expected.sourceRows &&
    report.keyedRows === expected.keyedRows &&
    report.uniqueKeys === expected.uniqueKeys &&
    report.missingKeyRows === expected.missingKeyRows &&
    report.checksum === expected.checksum &&
    duplicateKeys.length === 1 && duplicateKeys[0][0] === expected.duplicateKey && duplicateKeys[0][1] === 2;
  return { ok: exactShape, report, expected };
}

export function assertProductionImportSafe(rows) {
  const keys = rows.map(r => r.idempotency_key).filter(Boolean);
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const duplicateKeys = [...counts.entries()].filter(([, count]) => count > 1);
  const missingKeyRows = rows.filter(r => !r.idempotency_key);
  if (missingKeyRows.length !== 0 || duplicateKeys.length !== 0) {
    throw new Error('FAIL_CLOSED: source contains missing or duplicate idempotency keys; no rows may be silently dropped or overwritten');
  }
  return {
    sourceRows: rows.length,
    keyedRows: keys.length,
    uniqueKeys: new Set(keys).size,
    checksum: checksumRows(rows),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const filePath = process.argv[2];
  if (!filePath) throw new Error('usage: node scripts/preflight-atlas-execution-state.mjs <csv>');
  const rows = readExecutionStateCsv(filePath);
  const result = preflightExecutionState(rows);
  console.log(JSON.stringify(result, null, 2));
  // The verified historical export intentionally fails the production-import gate
  // because it contains 14 missing keys and one duplicate key. This command is a
  // source-integrity fingerprint check, not permission to import production data.
  process.exitCode = result.ok ? 0 : 2;
}
