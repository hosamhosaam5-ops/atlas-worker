// M4 schema: order ledger, files, delivery outbox, and quotes.
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
  await execSql(`CREATE TABLE IF NOT EXISTS order_files (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, file_kind TEXT NOT NULL, file_name TEXT NOT NULL, content_base64 TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(order_id,file_kind))`);
  await execSql(`CREATE TABLE IF NOT EXISTS delivery_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT NOT NULL UNIQUE, order_id TEXT NOT NULL, channel TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT, body TEXT, attachment_names TEXT, status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, provider_message_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`);
  await execSql(`CREATE TABLE IF NOT EXISTS order_quotes (quote_id INTEGER PRIMARY KEY AUTOINCREMENT, client_email TEXT NOT NULL, agreed_amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', note TEXT, product_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const pragma = db.prepare('PRAGMA table_info(order_ledger)');
  const { results } = pragma.bind ? await pragma.bind().all() : (pragma.all ? await pragma.all() : { results: [] });
  const have = new Set((results || []).map(r => r.name));
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
  const { results: outboxCols } = outboxPragma.bind ? await outboxPragma.bind().all() : (outboxPragma.all ? await outboxPragma.all() : { results: [] });
  const obHave = new Set((outboxCols || []).map(c => c.name));
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
  const { results: quoteCols } = quotePragma.bind ? await quotePragma.bind().all() : (quotePragma.all ? await quotePragma.all() : { results: [] });
  const quoteHave = new Set((quoteCols || []).map(c => c.name));
  if (!quoteHave.has('product_id')) await db.prepare('ALTER TABLE order_quotes ADD COLUMN product_id TEXT').bind().run();

  const ledgerPragmaAfter = db.prepare('PRAGMA table_xinfo(order_ledger)');
  const ledgerColsAfter = ledgerPragmaAfter.bind ? await ledgerPragmaAfter.bind().all() : (ledgerPragmaAfter.all ? await ledgerPragmaAfter.all() : { results: [] });
  const ledgerHaveAfter = new Set((ledgerColsAfter.results || []).map(r => r.name));
  if (ledgerHaveAfter.has('settlement_mode') && ledgerHaveAfter.has('chain_id') && !ledgerHaveAfter.has('settlement_integrity')) {
    await db.prepare(`ALTER TABLE order_ledger ADD COLUMN settlement_integrity INTEGER AS (
      CASE WHEN (
        (settlement_mode IN ('REAL','TESTNET') AND tx_hash IS NOT NULL AND tx_hash!='' AND chain_id IS NOT NULL AND chain_id!='')
        OR
        (settlement_mode IN ('SIMULATION','MOCK') AND (chain_id IS NULL OR chain_id=''))
      ) THEN 1 ELSE NULL END
    ) VIRTUAL NOT NULL`).run();
  }

  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_order_ledger_tx_hash
    ON order_ledger(tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash != ''`);
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_order_quotes_email ON order_quotes(client_email, status)');
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_order_quotes_product ON order_quotes(product_id, status)');
}
