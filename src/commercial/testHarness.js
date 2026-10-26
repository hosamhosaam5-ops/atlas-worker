// ATLAS production-pipeline integration harness.
// All scenarios use the real order pipeline and real D1 tables, but force MOCK payment/email
// adapters inside the harness. No blockchain transaction, external email, or money movement occurs.

import { ensureCommercialSchema, upsertProduct, createQuote } from './control.js';
import { processOrder, deliverOrder } from '../orders/intake.js';
import { ensureOrderSchema } from '../orders/schema.js';

const csvBytes = new TextEncoder().encode('name,value\n alpha , 10 \n alpha ,10\n beta,20\n,,\n');

function envForTest(env, paymentScenario='valid', emailScenario='success', amount=75) {
  return { ...env, ATLAS_WALLET_ADDRESS: env.ATLAS_WALLET_ADDRESS || '0x59Ea688b36464133E71873d8BeE8Fcb3BC369383', PAYMENT_PROVIDER:'MOCK', SETTLEMENT_MODE:'MOCK', CHAIN_ID:'', PAYMENT_MOCK_SCENARIO:paymentScenario, PAYMENT_MOCK_AMOUNT_USDC:String(amount), EMAIL_PROVIDER:'MOCK', EMAIL_MOCK_SCENARIO:emailScenario };
}

function tx(seed) {
  return '0x' + String(seed).padStart(64,'0');
}

export async function runCommercialIntegration(db, env, options={}) {
  // Fail closed: this harness writes synthetic orders into its supplied database.
  // Only an explicitly marked, isolated CI database may opt in; never set these markers in production.
  if (env?.ATLAS_TEST_DB !== '1' || env?.ATLAS_TEST_DB_ID !== 'atlas-ci-isolated' || env?.DB !== db) {
    throw new Error('HARNESS_REQUIRES_ISOLATED_TEST_D1');
  }
  await ensureCommercialSchema(db);
  await ensureOrderSchema(db);
  const suffix=Date.now().toString(16);
  const targetProductId=options?.product_id ? String(options.product_id).trim() : '';
  const email='atlas.integration.'+suffix+'@example.invalid';
  let productId=targetProductId;
  let amount=75;
  if(targetProductId){
    const target=await db.prepare("SELECT product_id,name,price_usdc,status FROM products WHERE product_id=? LIMIT 1").bind(targetProductId).first();
    if(!target || target.status!=='ACTIVE') throw new Error('TARGET_PRODUCT_NOT_ACTIVE');
    amount=Number(target.price_usdc);
    if(!(amount>0)) throw new Error('TARGET_PRODUCT_PRICE_INVALID');
  } else {
    productId='prod_integration_'+suffix;
    await upsertProduct(db,{product_id:productId,name:'ATLAS Integration Test Product',description:'Synthetic internal integration product',unit:'order',price_usdc:75,pricing_mode:'FOUNDER_QUOTE',status:'ACTIVE'});
  }
  const quote=await createQuote(db,{client_email:email,agreed_amount:amount,note:targetProductId?'synthetic active-product integration test':'synthetic integration test',product_id:productId});

  const safeProcess = async (label, input, e) => { try { return await processOrder(db,e,input); } catch (err) { return { order_id: input.__order_id, order_status: 'HARNESS_ERROR', error: String(err?.message || err), label }; } };

  const order=await safeProcess('order',{
    client_email:email,tx_hash:tx('1'+suffix),__order_id:'INT-'+suffix,__file_name:'input.csv',__file_bytes:csvBytes
  },envForTest(env,'valid','success',amount));
  const duplicate=await safeProcess('duplicate',{
    client_email:email,tx_hash:tx('1'+suffix),__order_id:'INT-DUP-'+suffix,__file_name:'input.csv',__file_bytes:csvBytes
  },envForTest(env,'valid','success'));

  const failEmail='atlas.recovery.'+suffix+'@example.invalid';
  await createQuote(db,{client_email:failEmail,agreed_amount:amount,note:'synthetic recovery test',product_id:productId});
  const failedDelivery=await safeProcess('recovery',{
    client_email:failEmail,tx_hash:tx('2'+suffix),__order_id:'REC-'+suffix,__file_name:'input.csv',__file_bytes:csvBytes
  },envForTest(env,'valid','fail',amount));
  const recoveredDelivery=await deliverOrder(db,envForTest(env,'valid','success',amount),'REC-'+suffix,failEmail,
    'ATLAS recovery verification','Synthetic recovery resend.',['clean_csv','qa_report']);
  if(recoveredDelivery.delivery_status==='SENT'){
    await db.prepare("UPDATE order_ledger SET status='DELIVERED',delivery_status='SENT',error=NULL,updated_at=datetime('now') WHERE order_id=? AND status='DELIVERY_FAILED'")
      .bind('REC-'+suffix).run();
  }

  const stressEmail='atlas.stress.'+suffix+'@example.invalid';
  await createQuote(db,{client_email:stressEmail,agreed_amount:amount,note:'synthetic concurrency test',product_id:productId});
  const calls=Array.from({length:8},(_,i)=>safeProcess('stress-'+i,{
    client_email:stressEmail,tx_hash:tx('3'+suffix),__order_id:'STRESS-'+suffix+'-'+i,__file_name:'input.csv',__file_bytes:csvBytes
  },envForTest(env,'valid','success',amount)));
  const stress=await Promise.all(calls);

  const counts={
    delivered:stress.filter(x=>x.order_status==='DELIVERED').length,
    duplicate_tx:stress.filter(x=>x.order_status==='DUPLICATE_TX').length,
    other:stress.filter(x=>!['DELIVERED','DUPLICATE_TX'].includes(x.order_status)).length,
    errors:stress.filter(x=>x.order_status==='HARNESS_ERROR').map(x=>({order_id:x.order_id,error:x.error,label:x.label}))
  };

  const ledger=await db.prepare("SELECT order_id,quote_ref,product_id,status,payment_status,delivery_status FROM order_ledger WHERE order_id=? LIMIT 1")
    .bind(order.order_id).first();
  const productIdInvariant=ledger?.product_id === productId && String(ledger?.quote_ref) === String(quote.quote_id);

  return {
    ok: order.order_status==='DELIVERED'
      && duplicate.order_status==='DUPLICATE_TX'
      && failedDelivery.order_status==='DELIVERY_FAILED'
      && recoveredDelivery.delivery_status==='SENT'
      && counts.delivered===1 && counts.duplicate_tx===7 && counts.other===0
      && productIdInvariant,
    product_id:productId,
    quote_id:quote.quote_id,
    product_id_invariant:{pass:productIdInvariant,quote_product_id:productId,ledger_product_id:ledger?.product_id ?? null,quote_id:quote.quote_id,ledger_quote_ref:ledger?.quote_ref ?? null},
    order:{order_id:order.order_id,status:order.order_status,payment_status:order.payment_status,delivery:order.delivery},
    duplicate:{order_id:duplicate.order_id,status:duplicate.order_status},
    recovery:{order_id:failedDelivery.order_id,first_status:failedDelivery.order_status,retry_status:recoveredDelivery.delivery_status},
    stress:counts,
    target_product_test:!!targetProductId,
    safety:'MOCK payment + MOCK email; no external funds or email sent'
  };
}
