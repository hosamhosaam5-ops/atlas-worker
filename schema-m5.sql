-- ATLAS Worker — M5 additions: unified outbox + global failure taxonomy.
-- The delivery_outbox table is shared by ALL channels (email + telegram + cron alerts).
-- dedupe_key is the single idempotency anchor: one real provider call per key, ever.

CREATE TABLE IF NOT EXISTS delivery_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,      -- e.g. 'order|ORD-1|email' | 'tg|<requestId>|chunk_0' | 'cron|<key>'
  order_id TEXT,                        -- order id when channel-bound to an order; dedupe_key otherwise
  channel TEXT NOT NULL,                -- 'email' | 'telegram'
  recipient TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  attachment_names TEXT,                -- 'kind:file_name,...' (bytes resolved from storage at send time)
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | SENDING | SENT | FAILED
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  provider_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON delivery_outbox(status);
CREATE INDEX IF NOT EXISTS idx_outbox_order ON delivery_outbox(order_id, channel);
