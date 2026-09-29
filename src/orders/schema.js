// M4 schema: M1's schema.sql created order_quotes (quote_id PK) and order_ledger with
// UNIQUE(tx_hash) partial index. This adds the M4 columns idempotently (SQLite has no
// IF NOT EXISTS for ALTER TABLE ADD COLUMN, so we probe pragma table_info first).

const M4_LEDGER_COLUMNS = [
  ['qa_status', 'TEXT'], ['qa_report', 'TEXT'], ['payment_status', 'TEXT'],
  ['amount_paid', 'REAL'], ['price_source', 'TEXT'], ['expected_amount', 'REAL'],
  ['file_name', 'TEXT'], ['file_ext', 'TEXT'], ['rows_in', 'INTEGER'], ['rows_out', 'INTEGER'],
  ['delivery_channel', 'TEXT'], ['delivery_status', 'TEXT'],
];

export async function ensureOrderSchema(db) {
  const { results } = await db.prepare('PRAGMA table_info(order_ledger)').bind().all();
  const have = new Set(results.map(r => r.name));
  for (const [name, type] of M4_LEDGER_COLUMNS) {
    if (!have.has(name)) {
      await db.prepare(`ALTER TABLE order_ledger ADD COLUMN ${name} ${type}`).bind().run();
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
  )`).bind().run();
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
  )`).bind().run();
  // M5: columns added for existing DBs created with the M4 outbox shape.
  const { results: outboxCols } = await db.prepare('PRAGMA table_info(delivery_outbox)').bind().all();
  const obHave = new Set(outboxCols.map(c => c.name));
  if (!obHave.has('dedupe_key')) {
    await db.prepare('ALTER TABLE delivery_outbox ADD COLUMN dedupe_key TEXT').bind().run();
    await db.prepare("UPDATE delivery_outbox SET dedupe_key = 'order|' || order_id || '|' || channel WHERE dedupe_key IS NULL").bind().run();
    await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedupe ON delivery_outbox(dedupe_key)').bind().run();
  }
  if (!obHave.has('provider_message_id')) {
    await db.prepare('ALTER TABLE delivery_outbox ADD COLUMN provider_message_id TEXT').bind().run();
  }
  await db.prepare(`CREATE TABLE IF NOT EXISTS order_quotes (
    quote_id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_email TEXT NOT NULL,
    agreed_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).bind().run();
  // Ensure the DB-level duplicate-payment guard exists (partial unique index).
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_order_ledger_tx_hash
    ON order_ledger(tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash != ''`).bind().run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_order_quotes_email ON order_quotes(client_email, status)`).bind().run();
}
