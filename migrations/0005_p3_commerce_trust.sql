-- ATLAS P3 trust + agent commerce state. Additive and idempotent.
CREATE TABLE IF NOT EXISTS commerce_sessions (session_id TEXT PRIMARY KEY,agent_id TEXT,product_id TEXT NOT NULL,stage TEXT NOT NULL,quote_id INTEGER,payment_ref TEXT,order_id TEXT,metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_commerce_sessions_stage ON commerce_sessions(stage,updated_at);
CREATE INDEX IF NOT EXISTS idx_commerce_sessions_agent ON commerce_sessions(agent_id,updated_at);