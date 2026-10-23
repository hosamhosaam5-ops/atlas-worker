// Commercial integration proof — isolated local D1 fixture, MOCK payment/email only.
// The fixture is created inside a disposable local SQLite database; it is not a
// production catalog product and never requires enabling the paused offer.
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
      const self = this;
      return {
        async run(...args) {
          const r=db.prepare(sql).run(...args);
          return {meta:{last_row_id:r.lastInsertRowid,changes:r.changes}};
        },
        async first(...args) { return db.prepare(sql).get(...args) ?? null; },
        async all(...args) { return {results:db.prepare(sql).all(...args)}; },
        bind(...args) {
          return {
            run: async () => self.prepare(sql).run(...args),
            first: async () => self.prepare(sql).first(...args),
            all: async () => self.prepare(sql).all(...args),
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

// This product exists only in the isolated test database. Keep its ID distinct
// from the paused production offer and from any historical integration products.
const fixtureProductId='atlas_test_fixture_data_qa';
await upsertProduct(db,{
  product_id:fixtureProductId,
  name:'ATLAS Synthetic Integration Fixture',
  description:'Local-only synthetic fixture; never offered to customers',
  unit:'test_dataset',
  price_usdc:1,
  pricing_mode:'FOUNDER_QUOTE',
  status:'ACTIVE'
});

const result=await runCommercialIntegration(db,{
  PAYMENT_PROVIDER:'MOCK',
  EMAIL_PROVIDER:'MOCK',
  FILE_STORAGE:'LOCAL'
},{product_id:fixtureProductId});

if(!result.ok || !result.target_product_test || result.product_id!==fixtureProductId) {
  throw new Error('ISOLATED_FIXTURE_INTEGRATION_FAILED: '+JSON.stringify(result));
}
if(!result.product_id_invariant?.pass || result.order?.status!=='DELIVERED' || result.order?.payment_status!=='PAID') {
  throw new Error('ISOLATED_FIXTURE_E2E_INVARIANT_FAILED: '+JSON.stringify(result));
}
if(result.stress?.delivered!==1 || result.stress?.duplicate_tx!==7 || result.stress?.other!==0 || (result.stress?.errors||[]).length) {
  throw new Error('ISOLATED_FIXTURE_IDEMPOTENCY_FAILED: '+JSON.stringify(result));
}
console.log('PASS isolated local fixture integration: '+JSON.stringify({
  product_id:result.product_id,
  quote_id:result.quote_id,
  delivered:result.order.status,
  payment:result.order.payment_status,
  stress:result.stress,
  safety:result.safety
}));
