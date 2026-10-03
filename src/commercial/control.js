// ATLAS commercial control plane: product catalog, quotes, and financial approvals.
// No payment is initiated here. Financial state is explicit and founder-gated.
export async function ensureCommercialSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS products (
    product_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'order',
    price_usdc REAL,
    pricing_mode TEXT NOT NULL DEFAULT 'FOUNDER_QUOTE',
    status TEXT NOT NULL DEFAULT 'DRAFT',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS financial_approvals (
    approval_id TEXT PRIMARY KEY,
    order_id TEXT,
    quote_id INTEGER,
    action TEXT NOT NULL,
    amount_usdc REAL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    requested_by TEXT NOT NULL,
    approved_by TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at TEXT
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_products_status ON products(status)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_financial_approvals_status ON financial_approvals(status, created_at)').run();
}

export async function listProducts(db, includeDrafts=false) {
  await ensureCommercialSchema(db);
  const q = includeDrafts
    ? 'SELECT product_id,name,description,unit,price_usdc,pricing_mode,status,version,created_at,updated_at FROM products ORDER BY updated_at DESC'
    : "SELECT product_id,name,description,unit,price_usdc,pricing_mode,status,version,created_at,updated_at FROM products WHERE status='ACTIVE' ORDER BY updated_at DESC";
  const { results } = await db.prepare(q).all();
  return results || [];
}

export async function upsertProduct(db, p) {
  await ensureCommercialSchema(db);
  const productId=String(p.product_id||'').trim();
  const name=String(p.name||'').trim();
  const description=String(p.description||'').trim();
  if(!productId||!name||!description) throw new Error('INVALID_PRODUCT');
  const status=['DRAFT','ACTIVE','PAUSED','ARCHIVED'].includes(String(p.status||'DRAFT'))?String(p.status||'DRAFT'):'DRAFT';
  const pricingMode=String(p.pricing_mode||'FOUNDER_QUOTE');
  const price=p.price_usdc==null?null:Number(p.price_usdc);
  if(price!==null && (!Number.isFinite(price)||price<=0)) throw new Error('INVALID_PRODUCT_PRICE');
  await db.prepare(`INSERT INTO products(product_id,name,description,unit,price_usdc,pricing_mode,status,version)
    VALUES(?,?,?,?,?,?,?,1)
    ON CONFLICT(product_id) DO UPDATE SET name=excluded.name,description=excluded.description,unit=excluded.unit,
    price_usdc=excluded.price_usdc,pricing_mode=excluded.pricing_mode,status=excluded.status,
    version=products.version+1,updated_at=datetime('now')`).bind(productId,name,description,String(p.unit||'order'),price,pricingMode,status).run();
  return await db.prepare('SELECT * FROM products WHERE product_id=?').bind(productId).first();
}

export async function createQuote(db,{client_email,agreed_amount,note='',product_id=null}) {
  await ensureCommercialSchema(db);
  const email=String(client_email||'').trim().toLowerCase();
  const amount=Number(agreed_amount);
  if(!email||!Number.isFinite(amount)||amount<=0) throw new Error('INVALID_QUOTE');
  const product=product_id?await db.prepare("SELECT product_id,status FROM products WHERE product_id=?").bind(String(product_id)).first():null;
  if(product_id && (!product || product.status!=='ACTIVE')) throw new Error('PRODUCT_NOT_ACTIVE');
  const r=await db.prepare('INSERT INTO order_quotes(client_email,agreed_amount,status,note) VALUES(?,?,\'ACTIVE\',?)').bind(email,amount,String(note||'')+(product_id?' [product:'+String(product_id)+']':'')).run();
  return {quote_id:r.meta.last_row_id,client_email:email,agreed_amount:amount,status:'ACTIVE',product_id:product_id||null};
}

export async function requestFinancialApproval(db,{order_id=null,quote_id=null,action,amount_usdc=null,requested_by='founder',reason=''}) {
  await ensureCommercialSchema(db);
  const allowed=['REFUND','PAYOUT','DISCOUNT','PRICE_OVERRIDE','EXTERNAL_SPEND'];
  if(!allowed.includes(String(action))) throw new Error('INVALID_FINANCIAL_ACTION');
  const amount=amount_usdc==null?null:Number(amount_usdc);
  if(amount!==null && (!Number.isFinite(amount)||amount<0)) throw new Error('INVALID_FINANCIAL_AMOUNT');
  const approvalId='apr_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);
  await db.prepare('INSERT INTO financial_approvals(approval_id,order_id,quote_id,action,amount_usdc,status,requested_by,reason) VALUES(?,?,?,?,?,?,?,?)')
    .bind(approvalId,order_id,quote_id,String(action),amount,'PENDING',String(requested_by),String(reason||'')).run();
  return {approval_id:approvalId,status:'PENDING',action:String(action),amount_usdc:amount};
}


export async function decideFinancialApproval(db,{approval_id,status,decided_by,reason=''}) {
  await ensureCommercialSchema(db);
  const id=String(approval_id||'').trim();
  const next=String(status||'').toUpperCase();
  const actor=String(decided_by||'').trim();
  if(!id||!actor) throw new Error('INVALID_APPROVAL_DECISION');
  if(!['APPROVED','REJECTED'].includes(next)) throw new Error('INVALID_APPROVAL_STATUS');
  const row=await db.prepare('SELECT * FROM financial_approvals WHERE approval_id=?').bind(id).first();
  if(!row) throw new Error('APPROVAL_NOT_FOUND');
  if(String(row.status)!=='PENDING') throw new Error('APPROVAL_ALREADY_DECIDED');
  await db.prepare("UPDATE financial_approvals SET status=?,approved_by=?,reason=?,decided_at=datetime('now') WHERE approval_id=? AND status='PENDING'")
    .bind(next,actor,String(reason||''),id).run();
  return await db.prepare('SELECT * FROM financial_approvals WHERE approval_id=?').bind(id).first();
}

export async function listFinancialApprovals(db,{status=null,limit=50}={}) {
  await ensureCommercialSchema(db);
  const n=Math.min(100,Math.max(1,Number(limit||50)));
  if(status){
    const s=String(status).toUpperCase();
    const {results}=await db.prepare('SELECT * FROM financial_approvals WHERE status=? ORDER BY created_at DESC LIMIT ?').bind(s,n).all();
    return results||[];
  }
  const {results}=await db.prepare('SELECT * FROM financial_approvals ORDER BY created_at DESC LIMIT ?').bind(n).all();
  return results||[];
}
