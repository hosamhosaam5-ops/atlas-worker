-- ATLAS Worker — M2 additions to schema (applied after M1's schema.sql).
-- CEO durable state: mirrors atlas_execution_state semantics (idempotency_key PK).
CREATE TABLE IF NOT EXISTS execution_state (
  idempotency_key TEXT PRIMARY KEY,
  record_kind TEXT,                -- 'ceo_state' | 'action_result' | 'request_result' | 'delivery'
  correlation_id TEXT,
  request_id TEXT,
  entity_type TEXT,                -- goal|task|decision|followup|learning|plan|approval
  entity_id TEXT,
  action_id TEXT,
  tool TEXT,
  status TEXT,
  progress REAL,
  payload_json TEXT,               -- entity payload OR {"final_reply": ...} for request_result
  error_code TEXT,
  attempt_count INTEGER DEFAULT 0,
  delivery_state TEXT,
  message_key TEXT,
  chunk_index INTEGER,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_state_request ON execution_state(request_id, record_kind);
CREATE INDEX IF NOT EXISTS idx_exec_state_entity ON execution_state(entity_type, entity_id);

-- CEO long-term memory: mirrors ceo_memory table.
CREATE TABLE IF NOT EXISTS ceo_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
