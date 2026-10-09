// M4 schema: order ledger, files, delivery outbox, and quotes.

// Ensure the tx-hash uniqueness index matches the intended non-empty-hash semantics.
// A stale index that also indexes empty strings is replaced atomically after checking
// that the target predicate has no duplicate non-empty hashes.
export async function ensureOrderLedgerTxHashIndex(db) {
  const readOne = async (sql) => {
    const stmt = db.prepare(sql);
    if (typeof stmt.first === 'function') return await stmt.first();
    if (typeof stmt.get === 'function') return stmt.get() ?? null;
    const rows = await stmt.all();
    return Array.isArray(rows) ? (rows[0] || null) : ((rows?.results || [])[0] || null);
  };
  const index = await readOne("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_order_ledger_tx_hash'");
  const sql = String(index?.sql || '');
  const desiredPredicate = /where\s+tx_hash\s+is\s+not\s+null\s+and\s+tx_hash\s*(?:!=|<>)\s*''/i;
  if (sql && desiredPredicate.test(sql)) return { changed: false, reason: 'already-correct' };
  if (!sql) {
    await db.prepare("CREATE UNIQUE INDEX idx_order_ledger_tx_hash ON order_ledger(tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash != ''").run();
    return { changed: true, reason: 'created' };
  }
  const duplicate = await readOne("SELECT tx_hash, COUNT(*) AS count FROM order_ledger WHERE tx_hash IS NOT NULL AND tx_hash != '' GROUP BY tx_hash HAVING COUNT(*) > 1 LIMIT 1");
  if (duplicate) throw new Error('INDEX_MIGRATION_DUPLICATE_TX_HASH');
  const dropSql = 'DROP INDEX idx_order_ledger_tx_hash';
  const createSql = "CREATE UNIQUE INDEX idx_order_ledger_tx_hash ON order_ledger(tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash != ''";
  if (typeof db.batch === 'function') {
    await db.batch([db.prepare(dropSql), db.prepare(createSql)]);
  } else if (typeof db.exec === 'function') {
    db.exec('BEGIN IMMEDIATE; ' + dropSql + '; ' + createSql + '; COMMIT;');
  } else {
    throw new Error('INDEX_MIGRATION_BATCH_REQUIRED');
  }
  return { changed: true, reason: 'recreated' };
}
// Schema evolution is idempotent so existing production data is preserved.

const M4_LEDGER_COLUMNS = [
  ['qa_status', 'TEXT'], ['qa_report', 'TEXT'], ['payment_status', 'TEXT'],
  ['amount_paid', 'REAL'], ['price_source', 'TEXT'], ['expected_amount', 'REAL'],
  ['file_name', 'TEXT'], ['file_ext', 'TEXT'], ['rows_in', 'INTEGER'], ['rows_out', 'INTEGER'],
  ['delivery_channel', 'TEXT'], ['delivery_status', 'TEXT'], ['product_id', 'TEXT'],
  ['settlement_mode', "TEXT NOT NULL DEFAULT 'MOCK' CHECK (settlement_mode IN ('REAL','TESTNET','SIMULATION','MOCK'))"],
  ['chain_id', 'TEXT'],
];

export async function ensureOrderSchema(db) {
  const execSql = async (sql) => {
    if (db.execRaw) return db.execRaw(sql);
    if (db.exec) return db.exec(sql);
    return db.prepare(sql).run();
  };
  const pragmaRows = async (stmt) => {
    if (stmt.bind) {
      const r = await stmt.bind().all();
      return r?.results || [];
    }
    const r = await stmt.all();
    return Array.isArray(r) ? r : (r?.results || []);
  };
  await execSql(`CREATE TABLE IF NOT EXISTS order_files (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, file_kind TEXT NOT NULL, file_name TEXT NOT NULL, content_base64 TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(order_id,file_kind))`);
  await execSql(`CREATE TABLE IF NOT EXISTS delivery_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT NOT NULL UNIQUE, order_id TEXT NOT NULL, channel TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT, body TEXT, attachment_names TEXT, status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, provider_message_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`);
  await execSql(`CREATE TABLE IF NOT EXISTS order_quotes (quote_id INTEGER PRIMARY KEY AUTOINCREMENT, client_email TEXT NOT NULL, agreed_amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', note TEXT, product_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const pragma = db.prepare('PRAGMA table_info(order_ledger)');
  const results = await pragmaRows(pragma);
  const have = new Set(results.map(r => r.name));
  for (const [name, type] of M4_LEDGER_COLUMNS) {
    if (!have.has(name)) {
      const stmt = db.prepare(`ALTER TABLE order_ledger ADD COLUMN ${name} ${type}`);
      if (stmt.bind) await stmt.bind().run();
      else if (stmt.run) await stmt.run();
      else if (db.exec) await db.exec(`ALTER TABLE order_ledger ADD COLUMN ${name} ${type}`);
    }
  }

  await db.prepare(`CREATE TABLE IF NOT EXISTS order_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    file_kind TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_base64 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(order_id, file_kind)
  )`);

  await db.prepare(`CREATE TABLE IF NOT EXISTS delivery_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    order_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT,
    body TEXT,
    attachment_names TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    provider_message_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  )`);

  const outboxPragma = db.prepare('PRAGMA table_info(delivery_outbox)');
  const outboxCols = await pragmaRows(outboxPragma);
  const obHave = new Set(outboxCols.map(c => c.name));
  if (!obHave.has('dedupe_key')) {
    await db.prepare('ALTER TABLE delivery_outbox ADD COLUMN dedupe_key TEXT').bind().run();
    await db.prepare("UPDATE delivery_outbox SET dedupe_key = 'order|' || order_id || '|' || channel WHERE dedupe_key IS NULL").bind().run();
    await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedupe ON delivery_outbox(dedupe_key)').bind().run();
  }
  if (!obHave.has('provider_message_id')) await db.prepare('ALTER TABLE delivery_outbox ADD COLUMN provider_message_id TEXT').bind().run();

  // Quote table is also ensured here because the order engine consumes it.
  await db.prepare(`CREATE TABLE IF NOT EXISTS order_quotes (
    quote_id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_email TEXT NOT NULL,
    agreed_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    note TEXT,
    product_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const quotePragma = db.prepare('PRAGMA table_info(order_quotes)');
  const quoteCols = await pragmaRows(quotePragma);
  const quoteHave = new Set(quoteCols.map(c => c.name));
  if (!quoteHave.has('product_id')) await db.prepare('ALTER TABLE order_quotes ADD COLUMN product_id TEXT').bind().run();

  const ledgerPragmaAfter = db.prepare('PRAGMA table_xinfo(order_ledger)');
  const ledgerColsAfter = await pragmaRows(ledgerPragmaAfter);
  const ledgerHaveAfter = new Set(ledgerColsAfter.map(r => r.name));
  if (ledgerHaveAfter.has('settlement_mode') && ledgerHaveAfter.has('chain_id') && ledgerHaveAfter.has('settlement_integrity')) {
    const schemaRow = await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='order_ledger'").first();
    const schemaSql = String(schemaRow?.sql || '');
    // Repair the pre-M6 integrity expression if it incorrectly required MOCK/SIMULATION
    // rows to have a NULL tx_hash. MOCK/SIMULATION may retain a synthetic tx hash for
    // idempotency; only chain_id must be absent. REAL/TESTNET still require both proof fields.
    if (schemaSql.includes("AND (tx_hash IS NULL OR tx_hash='')")) {
      await execSql('ALTER TABLE order_ledger DROP COLUMN settlement_integrity');
      await execSql(`ALTER TABLE order_ledger ADD COLUMN settlement_integrity INTEGER AS (
        CASE WHEN (
          (settlement_mode IN ('REAL','TESTNET') AND tx_hash IS NOT NULL AND tx_hash!='' AND chain_id IS NOT NULL AND chain_id!='')
          OR
          (settlement_mode IN ('SIMULATION','MOCK') AND (chain_id IS NULL OR chain_id=''))
        ) THEN 1 ELSE NULL END
      ) VIRTUAL NOT NULL`);
    }
  }

  if (ledgerHaveAfter.has('settlement_mode') && ledgerHaveAfter.has('chain_id') && !ledgerHaveAfter.has('settlement_integrity')) {
    const integrityStmt = db.prepare(`ALTER TABLE order_ledger ADD COLUMN settlement_integrity INTEGER AS (
      CASE WHEN (
        (settlement_mode IN ('REAL','TESTNET') AND tx_hash IS NOT NULL AND tx_hash!='' AND chain_id IS NOT NULL AND chain_id!='')
        OR
        (settlement_mode IN ('SIMULATION','MOCK') AND (chain_id IS NULL OR chain_id=''))
      ) THEN 1 ELSE NULL END
    ) VIRTUAL NOT NULL`);
    if (integrityStmt.bind) await integrityStmt.bind().run();
    else await integrityStmt.run();
  }

  // Production D1 supports atomic batch/exec migrations. Lightweight test adapters may
  // omit those primitives; keep their legacy idempotent path and test the migration helper
  // directly against SQLite in test/order-index-migration.test.mjs.
  const indexProbe = db.prepare('SELECT 1');
  const canInspectIndex = typeof indexProbe.first === 'function' || typeof indexProbe.get === 'function' || typeof indexProbe.all === 'function';
  if (typeof db.batch === 'function' || (typeof db.exec === 'function' && canInspectIndex)) {
    await ensureOrderLedgerTxHashIndex(db);
  } else {
    await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_order_ledger_tx_hash ON order_ledger(tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash != ''").run();
  }
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_order_quotes_email ON order_quotes(client_email, status)');
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_order_quotes_product ON order_quotes(product_id, status)');
}
