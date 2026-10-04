-- ATLAS Serverless D1 Schema — M1
-- Idempotency enforced at DB level (UNIQUE), not just in code.

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,               -- 'telegram', future: 'form', 'cron', ...
  external_id TEXT NOT NULL,          -- telegram: update_id (as TEXT)
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROCESSED',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS order_quotes (
  quote_id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_email TEXT NOT NULL,         -- normalized lower-case; NOT a PK
  agreed_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | USED | CANCELLED
  note TEXT,
  product_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- More than one ACTIVE quote per client is ambiguous and must be rejected
-- by application logic (same as current n8n design), but the DB allows
-- multiple quotes per client for future use (founder instruction #3).

CREATE TABLE IF NOT EXISTS order_ledger (
  order_id TEXT PRIMARY KEY,
  client_email TEXT,
  tx_hash TEXT,
  quote_ref INTEGER,
  product_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
-- Duplicate-payment protection at DB level: a tx_hash may appear once.
-- (NULLs allowed: orders before payment have no tx_hash yet.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_ledger_tx_hash
  ON order_ledger(tx_hash) WHERE tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_log_source ON event_log(source, created_at);
