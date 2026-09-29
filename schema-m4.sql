-- ATLAS Serverless D1 Schema — M4 (Order Intake)
-- quote_id is PRIMARY KEY (founder correction, ratified M1). Multiple quotes per client
-- are allowed, but more than one ACTIVE quote per client_email must yield MULTIPLE_QUOTES.
-- order_quotes / order_ledger are created by schema.sql (M1) with quote_id PK and
-- the UNIQUE(tx_hash) partial index. M4 adds any missing ledger columns idempotently
-- at apply time (orderIntake.ensureSchema), keeping the DB the source of truth.
CREATE INDEX IF NOT EXISTS idx_order_quotes_email ON order_quotes(client_email, status);

-- Full order ledger. One row per order, terminal states recorded (no free delivery).
-- statuses: REJECTED | NO_QUOTE | MULTIPLE_QUOTES | DUPLICATE_TX | PAYMENT_FAILED |
--           QA_FAILED | DELIVERY_FAILED | DELIVERED
-- New M4 columns on order_ledger (added by ensureSchema via ALTER TABLE IF missing):
--   qa_status, qa_report, payment_status, amount_paid, price_source, expected_amount,
--   file_name, file_ext, rows_in, rows_out, delivery_channel, delivery_status
-- order_ledger.status taxonomy: REJECTED | NO_QUOTE | MULTIPLE_QUOTES | DUPLICATE_TX |
--   PAYMENT_FAILED | QA_FAILED | DELIVERY_FAILED | DELIVERED
-- payment_status taxonomy: NOT_CHECKED | PAID | NOT_FOUND | TX_FAILED | AMOUNT_MISMATCH |
--   NOT_USDC_TO_WALLET | REUSED_TX | INVALID_RECEIPT | PAYMENT_PROVIDER_ERROR

-- Stored files (clean CSV, QA report). FILE_STORAGE=LOCAL for tests, R2 later.
CREATE TABLE IF NOT EXISTS order_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  file_kind TEXT NOT NULL,                 -- clean_csv | qa_report
  file_name TEXT NOT NULL,
  content_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(order_id, file_kind)
);

-- Delivery outbox. NOTE: the table itself is created by schema-m5.sql in its final
-- unified form (dedupe_key UNIQUE). M4 only documents the contract; creating it here
-- with a different shape would shadow M5's CREATE IF NOT EXISTS and break the outbox.
-- Exactly-once semantics are enforced in M5 by UNIQUE(dedupe_key).
