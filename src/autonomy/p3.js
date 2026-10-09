// P3: agent commerce trust and verified reputation. Read-heavy, additive, zero outbound spend.
const WALLET = '0x59Ea688b36464133E71873d8BeE8Fcb3BC369383';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NETWORK = 'eip155:8453';

async function ensureP3Schema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS commerce_sessions (
    session_id TEXT PRIMARY KEY,
    agent_id TEXT,
    product_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    quote_id INTEGER,
    payment_ref TEXT,
    order_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_commerce_sessions_stage ON commerce_sessions(stage,updated_at)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_commerce_sessions_agent ON commerce_sessions(agent_id,updated_at)').run();
}

export function commerceManifest(origin, { product_id = 'atlas_ai_data_qa_v1', price_usdc = 15, wallet = WALLET } = {}) {
  return {
    schema_version: 'atlas.commerce.v1',
    provider: 'ATLAS',
    audience: 'AI agents and agent systems',
    product_id,
    pricing: { mode: 'FOUNDER_QUOTE', indicative_usdc: Number(price_usdc) },
    lifecycle: ['DISCOVER', 'QUOTE', 'PAY', 'VERIFY', 'EXECUTE', 'DELIVER', 'REPUTATION', 'REPEAT'],
    protocols: {
      mcp: origin + '/mcp',
      a2a: origin + '/a2a',
      x402_requirements: origin + '/x402/' + encodeURIComponent(product_id)
    },
    payment: {
      network: NETWORK,
      asset: USDC,
      payTo: String(wallet || WALLET),
      settlement: 'BASE_RPC_INBOUND',
      x402_settlement: 'NOT_ACTIVE'
    },
    safety: { outbound_spend_usdc: 0, external_outreach: 'FOUNDER_CONTROLLED', automatic_payouts: false }
  };
}

export async function trustSnapshot(db) {
  await ensureP3Schema(db);
  // Only non-MOCK ledger rows with a product and non-placeholder customer identity
  // count as production evidence. Synthetic harness/stress fixtures must never inflate
  // public delivery or payment reputation.
  const verifiedWhere = "COALESCE(settlement_mode,'MOCK')!='MOCK' AND product_id IS NOT NULL AND COALESCE(client_email,'') NOT LIKE '%@example.invalid'";
  const delivered = await db.prepare(`SELECT COUNT(*) count FROM order_ledger WHERE status='DELIVERED' AND ${verifiedWhere}`).first();
  const failed = await db.prepare(`SELECT COUNT(*) count FROM order_ledger WHERE status IN ('DELIVERY_FAILED','FAILED','REVIEW_REQUIRED','QA_FAILED') AND ${verifiedWhere}`).first();
  const paid = await db.prepare(`SELECT COUNT(*) count FROM order_ledger WHERE payment_status='PAID' AND ${verifiedWhere}`).first();
  const verifiedOrders = await db.prepare(`SELECT COUNT(*) count FROM order_ledger WHERE ${verifiedWhere}`).first();
  const simulated = await db.prepare("SELECT COUNT(*) count FROM order_ledger WHERE COALESCE(settlement_mode,'MOCK')='MOCK'").first();
  const simulatedPaid = await db.prepare("SELECT COUNT(*) count FROM order_ledger WHERE COALESCE(settlement_mode,'MOCK')='MOCK' AND payment_status='PAID'").first();
  const rep = await db.prepare("SELECT COUNT(*) count FROM reputation_events").first();
  const recent = await db.prepare(`SELECT product_id,status,payment_status,delivery_status,created_at,updated_at FROM order_ledger WHERE ${verifiedWhere} ORDER BY created_at DESC LIMIT 20`).all();
  const d = Number(delivered?.count || 0);
  const f = Number(failed?.count || 0);
  const p = Number(paid?.count || 0);
  const completed = d + f;
  return {
    ok: true,
    verified: true,
    verification_scope: 'LIVE_LEDGER_QUERY; MOCK_SETTLEMENTS_EXCLUDED',
    metrics: {
      delivered_orders: d,
      failed_or_review_orders: f,
      paid_orders: p,
      reputation_events: Number(rep?.count || 0),
      simulated_orders_excluded: Number(simulated?.count || 0),
      simulated_paid_orders_excluded: Number(simulatedPaid?.count || 0),
      verified_production_orders: Number(verifiedOrders?.count || 0)
    },
    recent: recent.results || [],
    methodology: "Production trust metrics include only non-MOCK settlement rows with a product_id and non-placeholder customer identity. MOCK/test/stress records are excluded; simulated counts are reported separately."
  };
}

export async function createCommerceSession(db, { agent_id, product_id = 'atlas_ai_data_qa_v1' } = {}) {
  await ensureP3Schema(db);
  if (!product_id) throw new Error('PRODUCT_REQUIRED');
  const id = 'cs_' + crypto.randomUUID().replaceAll('-', '').slice(0, 20);
  await db.prepare("INSERT INTO commerce_sessions(session_id,agent_id,product_id,stage) VALUES(?,?,?,'DISCOVER')")
    .bind(id, String(agent_id || 'anonymous').slice(0, 200), String(product_id).slice(0, 200)).run();
  return { ok: true, session_id: id, stage: 'DISCOVER', next: 'QUOTE', outbound_spend_usdc: 0 };
}

export async function advanceCommerceSession(db, { session_id, stage, quote_id = null, payment_ref = null, order_id = null } = {}) {
  await ensureP3Schema(db);
  const allowed = ['DISCOVER', 'QUOTE', 'PAY', 'VERIFY', 'EXECUTE', 'DELIVER', 'REPUTATION', 'REPEAT'];
  if (!allowed.includes(String(stage))) throw new Error('INVALID_COMMERCE_STAGE');
  const row = await db.prepare('SELECT session_id,product_id,stage FROM commerce_sessions WHERE session_id=?')
    .bind(String(session_id || '')).first();
  if (!row) throw new Error('COMMERCE_SESSION_NOT_FOUND');
  const current = allowed.indexOf(String(row.stage));
  const next = allowed.indexOf(String(stage));
  if (next < current || next > current + 1) throw new Error('INVALID_STAGE_TRANSITION');
  await db.prepare("UPDATE commerce_sessions SET stage=?,quote_id=COALESCE(?,quote_id),payment_ref=COALESCE(?,payment_ref),order_id=COALESCE(?,order_id),updated_at=datetime('now') WHERE session_id=?")
    .bind(String(stage), quote_id, payment_ref, order_id, String(session_id)).run();
  return { ok: true, session_id: String(session_id), stage: String(stage), product_id: row.product_id };
}

export async function commerceSnapshot(db) {
  await ensureP3Schema(db);
  const q = await db.prepare("SELECT stage,COUNT(*) count FROM commerce_sessions GROUP BY stage ORDER BY stage").all();
  return { ok: true, sessions: q.results || [], trust: await trustSnapshot(db) };
}
