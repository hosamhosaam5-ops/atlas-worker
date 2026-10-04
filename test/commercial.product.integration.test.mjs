// Commercial product integration proof — local D1, real order pipeline, MOCK payment/email only.
// This verifies the ACTIVE catalog product path, not a live customer transaction.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, unlinkSync } from 'node:fs';
import { ensureCommercialSchema, upsertProduct } from '../src/commercial/control.js';
import { ensureOrderSchema } from '../src/orders/schema.js';
import { runCommercialIntegration } from '../src/commercial/testHarness.js';

function makeD1(file) {
  try { unlinkSync(file); } catch {}
  const db = new DatabaseSync(file);
  return {
    prepare(sql) {
      return {
        bind(...args) {
          const s = db.prepare(sql);
          return {
            async run() { const r=s.run(...args); return {meta:{last_row_id:r.lastInsertRowid,changes:r.changes}}; },
            async first() { return s.get(...args) ?? null; },
            async all() { return {results:s.all(...args)}; },
          };
        },
      };
    },
    async execRaw(sql) { db.exec(sql); },
  };
}

const db=makeD1('/tmp/atlas-commercial-product.sqlite');
for (const f of ['schema.sql','schema-m2.sql','schema-m3.sql']) {
  await db.execRaw(readFileSync(new URL('../'+f, import.meta.url).pathname.replace(/%20/g,' '),'utf8'));
}
await ensureOrderSchema(db);
await ensureCommercialSchema(db);
await upsertProduct(db,{
  product_id:'atlas_ai_data_qa_v1',
  name:'AI Agent Data QA & Transformation',
  description:'Test catalog copy',
  unit:'dataset',
  price_usdc:15,
  pricing_mode:'FOUNDER_QUOTE',
  status:'ACTIVE'
});

const result=await runCommercialIntegration(db,{
  PAYMENT_PROVIDER:'MOCK',
  EMAIL_PROVIDER:'MOCK',
  FILE_STORAGE:'LOCAL'
},{product_id:'atlas_ai_data_qa_v1'});

if(!result.ok || !result.target_product_test || result.product_id!=='atlas_ai_data_qa_v1') {
  throw new Error('ACTIVE_PRODUCT_INTEGRATION_FAILED: '+JSON.stringify(result));
}
if(!result.product_id_invariant?.pass || result.order?.status!=='DELIVERED' || result.order?.payment_status!=='PAID') {
  throw new Error('ACTIVE_PRODUCT_E2E_INVARIANT_FAILED: '+JSON.stringify(result));
}
if(result.stress?.delivered!==1 || result.stress?.duplicate_tx!==7 || result.stress?.other!==0 || (result.stress?.errors||[]).length) {
  throw new Error('ACTIVE_PRODUCT_IDEMPOTENCY_FAILED: '+JSON.stringify(result));
}
console.log('PASS active catalog product integration: '+JSON.stringify({
  product_id:result.product_id,
  quote_id:result.quote_id,
  delivered:result.order.status,
  payment:result.order.payment_status,
  stress:result.stress,
  safety:result.safety
}));
