// ATLAS production-pipeline integration harness.
// All scenarios use the real order pipeline and real D1 tables, but force MOCK payment/email
// adapters inside the harness. No blockchain transaction, external email, or money movement occurs.

import { ensureCommercialSchema, upsertProduct, createQuote } from './control.js';
import { processOrder, deliverOrder } from '../orders/intake.js';
import { ensureOrderSchema } from '../orders/schema.js';

const csvBytes = new TextEncoder().encode('name,value\\n alpha , 10 \\n alpha ,10\\n beta,20\\n,,\\n');

function envForTest(env, paymentScenario='valid', emailScenario='success') {
  return { ...env, PAYMENT_PROVIDER:'MOCK', PAYMENT_MOCK_SCENARIO:paymentScenario, PAYMENT_MOCK_AMOUNT_USDC:'75', EMAIL_PROVIDER:'MOCK', EMAIL_MOCK_SCENARIO:emailScenario };
}

function tx(seed) {
  return '0x' + String(seed).padStart(64,'0');
}

export async function runCommercialIntegration(db, env) {
  await ensureCommercialSchema(db);
  await ensureOrderSchema(db);
  const suffix=Date.now().toString(16);
  const email='atlas.integration.'+suffix+'@example.invalid';
  const productId='prod_integration_'+suffix;
  await upsertProduct(db,{product_id:productId,name:'ATLAS Integration Test Product',description:'Synthetic internal integration product',unit:'order',price_usdc:75,pricing_mode:'FOUNDER_QUOTE',status:'ACTIVE'});
  const quote=await createQuote(db,{client_email:email,agreed_amount:75,note:'synthetic integration test',product_id:productId});

  const safeProcess = async (label, input, e) => { try { return await processOrder(db,e,input); } catch (err) { return { order_id: input.__order_id, order_status: 'HARNESS_ERROR', error: String(err?.message || err), label }; } };

  const order=await safeProcess('order',{
    client_email:email,tx_hash:tx('1'+suffix),__order_id:'INT-'+suffix,__file_name:'input.csv',__file_bytes:csvBytes
  },envForTest(env,'valid','success'));
  const duplicate=await safeProcess('duplicate',{
    client_email:email,tx_hash:tx('1'+suffix),__order_id:'INT-DUP-'+suffix,__file_name:'input.csv',__file_bytes:csvBytes
  },envForTest(env,'valid','success'));

  const failEmail='atlas.recovery.'+suffix+'@example.invalid';
  const recoveryQuote=await createQuote(db,{client_email:failEmail,agreed_amount:75,note:'synthetic recovery test',product_id:productId});
  const failedDelivery=await safeProcess('recovery',{
    client_email:failEmail,tx_hash:tx('2'+suffix),__order_id:'REC-'+suffix,__file_name:'input.csv',__file_bytes:csvBytes
  },envForTest(env,'valid','fail'));
  const recoveredDelivery=await deliverOrder(db,envForTest(env,'valid','success'),'REC-'+suffix,failEmail,
    'ATLAS recovery verification','Synthetic recovery resend.',['clean_csv','qa_report']);
  if(recoveredDelivery.delivery_status==='SENT'){
    await db.prepare("UPDATE order_ledger SET status='DELIVERED',delivery_status='SENT',error=NULL,updated_at=datetime('now') WHERE order_id=? AND status='DELIVERY_FAILED'")
      .bind('REC-'+suffix).run();
  }

  const stressEmail='atlas.stress.'+suffix+'@example.invalid';
  await createQuote(db,{client_email:stressEmail,agreed_amount:75,note:'synthetic concurrency test',product_id:productId});
  const calls=Array.from({length:8},(_,i)=>safeProcess('stress-'+i,{
    client_email:stressEmail,tx_hash:tx('3'+suffix),__order_id:'STRESS-'+suffix+'-'+i,__file_name:'input.csv',__file_bytes:csvBytes
  },envForTest(env,'valid','success')));
  const stress=await Promise.all(calls);

  const counts={
    delivered:stress.filter(x=>x.order_status==='DELIVERED').length,
    duplicate_tx:stress.filter(x=>x.order_status==='DUPLICATE_TX').length,
    other:stress.filter(x=>!['DELIVERED','DUPLICATE_TX'].includes(x.order_status)).length,
    errors:stress.filter(x=>x.order_status==='HARNESS_ERROR').map(x=>({order_id:x.order_id,error:x.error,label:x.label}))
  };

  return {
    ok: order.order_status==='DELIVERED'
      && duplicate.order_status==='DUPLICATE_TX'
      && failedDelivery.order_status==='DELIVERY_FAILED'
      && recoveredDelivery.delivery_status==='SENT'
      && counts.delivered===1 && counts.duplicate_tx===7 && counts.other===0,
    product_id:productId,
    quote_id:quote.quote_id,
    order:{order_id:order.order_id,status:order.order_status,payment_status:order.payment_status,delivery:order.delivery},
    duplicate:{order_id:duplicate.order_id,status:duplicate.order_status},
    recovery:{order_id:failedDelivery.order_id,first_status:failedDelivery.order_status,retry_status:recoveredDelivery.delivery_status},
    stress:counts,
    safety:'MOCK payment + MOCK email; no external funds or email sent'
  };
}
