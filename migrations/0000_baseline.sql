-- ATLAS D1 baseline migration
-- This migration is intentionally idempotent because atlas_db already contains
-- this schema. It documents the production baseline without deleting or changing data.

CREATE TABLE IF NOT EXISTS acquisition_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset TEXT,
  status TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS bountybook_auth_nonces (
  nonce TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS bridge_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  operation TEXT,
  status TEXT,
  auth_result TEXT,
  timestamp TEXT,
  error_summary TEXT
);

CREATE TABLE IF NOT EXISTS ceo_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channel_watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT,
  verdict TEXT,
  status TEXT,
  check_date TEXT
);

CREATE TABLE IF NOT EXISTS delivery_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  order_id TEXT,
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
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROCESSED',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS execution_state (
  idempotency_key TEXT PRIMARY KEY,
  record_kind TEXT,
  correlation_id TEXT,
  request_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  action_id TEXT,
  tool TEXT,
  status TEXT,
  progress REAL,
  payload_json TEXT,
  error_code TEXT,
  attempt_count INTEGER DEFAULT 0,
  delivery_state TEXT,
  message_key TEXT,
  chunk_index INTEGER,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS financial_approvals (
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
);

CREATE TABLE IF NOT EXISTS order_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  file_kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(order_id, file_kind)
);

CREATE TABLE IF NOT EXISTS order_ledger (
  order_id TEXT PRIMARY KEY,
  client_email TEXT,
  tx_hash TEXT,
  quote_ref INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  qa_status TEXT,
  qa_report TEXT,
  payment_status TEXT,
  amount_paid REAL,
  price_source TEXT,
  expected_amount REAL,
  file_name TEXT,
  file_ext TEXT,
  rows_in INTEGER,
  rows_out INTEGER,
  delivery_channel TEXT,
  delivery_status TEXT
);

CREATE TABLE IF NOT EXISTS order_quotes (
  quote_id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_email TEXT NOT NULL,
  agreed_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
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
);

CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT,
  asset TEXT,
  status TEXT,
  publication_time TEXT
);

CREATE TABLE IF NOT EXISTS zatca_experiment_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_key TEXT UNIQUE,
  business_type TEXT,
  revenue_band TEXT,
  qualified TEXT,
  submitted_at TEXT,
  attr_source TEXT,
  attr_campaign TEXT,
  attr_content TEXT
);

CREATE INDEX IF NOT EXISTS idx_bridge_audit_ts ON bridge_audit(timestamp);
CREATE INDEX IF NOT EXISTS idx_event_log_source ON event_log(source, created_at);
CREATE INDEX IF NOT EXISTS idx_event_log_status_created ON event_log(status, created_at);
CREATE INDEX IF NOT EXISTS idx_exec_state_entity ON execution_state(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_exec_state_request ON execution_state(request_id, record_kind);
CREATE INDEX IF NOT EXISTS idx_execution_state_kind_status ON execution_state(record_kind, status);
CREATE INDEX IF NOT EXISTS idx_financial_approvals_status ON financial_approvals(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_ledger_tx_hash ON order_ledger(tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_quotes_email ON order_quotes(client_email, status);
CREATE INDEX IF NOT EXISTS idx_outbox_order ON delivery_outbox(order_id, channel);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON delivery_outbox(status);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_zatca_req_time ON zatca_experiment_requests(submitted_at);
CREATE INDEX IF NOT EXISTS idx_zatca_source_campaign ON zatca_experiment_requests(attr_source, attr_campaign);
