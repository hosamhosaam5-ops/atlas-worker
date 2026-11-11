#!/usr/bin/env node
// ATLAS M6A migration preflight.
// Reads the preserved n8n atlas_execution_state CSV and produces deterministic,
// fail-closed source evidence. This does NOT connect to D1 and never mutates data.

import fs from 'node:fs';
import crypto from 'node:crypto';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/verify-atlas-execution-state.mjs <csv>');
  process.exit(2);
}

const csv = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
function parseCsv(s) {
  const rows=[]; let row=[], cell='', quoted=false;
  for (let i=0;i<s.length;i++) {
    const c=s[i], n=s[i+1];
    if (quoted) {
      if (c === '"' && n === '"') { cell+='"'; i++; }
      else if (c === '"') quoted=false;
      else cell+=c;
    } else if (c === '"') quoted=true;
    else if (c === ',') { row.push(cell); cell=''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row=[]; cell=''; }
    else if (c !== '\r') cell+=c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const [header,...body]=rows;
  return body.filter(r => r.some(Boolean)).map(r => Object.fromEntries(header.map((h,i)=>[h,r[i] ?? ''])));
}
function checksum(rows) {
  const canon=rows.map(r=>JSON.stringify(Object.keys(r).sort().reduce((o,k)=>(o[k]=r[k],o),{}))).sort().join('\n');
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0,16);
}
const rows=parseCsv(csv);
const keyed=rows.filter(r=>r.idempotency_key);
const counts=new Map();
for (const r of keyed) counts.set(r.idempotency_key,(counts.get(r.idempotency_key)||0)+1);
const duplicates=[...counts].filter(([,n])=>n>1);
const missing=rows.filter(r=>!r.idempotency_key);
const result={
  source_file:file,
  source_rows:rows.length,
  keyed_rows:keyed.length,
  unique_idempotency_keys:counts.size,
  missing_idempotency_key_rows:missing.length,
  duplicate_keys:duplicates,
  source_checksum:checksum(rows),
  importable_unique_rows:counts.size,
  fail_closed_conditions:{
    missing_idempotency_key_rows:missing.length>0,
    duplicate_keys:duplicates.length>0
  }
};
console.log(JSON.stringify(result,null,2));
if (missing.length || duplicates.length) process.exitCode=1;
