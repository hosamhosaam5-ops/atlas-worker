-- ATLAS Autonomy P0/P1 foundation. Additive and idempotent.
CREATE TABLE IF NOT EXISTS capabilities (
  capability_id TEXT PRIMARY KEY, kind TEXT NOT NULL, provider TEXT NOT NULL, protocol TEXT,
  endpoint TEXT, cost_class TEXT NOT NULL, risk TEXT NOT NULL, status TEXT NOT NULL,
  score REAL DEFAULT 0, metadata_json TEXT DEFAULT '{}', last_tested_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);
CREATE TABLE IF NOT EXISTS autonomy_policies (
  policy_id TEXT PRIMARY KEY, max_tool_calls INTEGER NOT NULL DEFAULT 20,
  max_retries INTEGER NOT NULL DEFAULT 3, max_execution_seconds INTEGER NOT NULL DEFAULT 120,
  max_external_requests INTEGER NOT NULL DEFAULT 30, max_build_iterations INTEGER NOT NULL DEFAULT 5,
  outbound_spend_allowed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS agent_identity (
  identity_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, protocol TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE', reputation_score REAL NOT NULL DEFAULT 0,
  successful_orders INTEGER NOT NULL DEFAULT 0, disputed_orders INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);
CREATE TABLE IF NOT EXISTS reputation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, identity_id TEXT NOT NULL, event_type TEXT NOT NULL,
  order_id TEXT, score_delta REAL NOT NULL DEFAULT 0, evidence_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS demand_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, signal_key TEXT NOT NULL,
  request_summary TEXT, score REAL DEFAULT 0, status TEXT DEFAULT 'NEW',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_capabilities_kind_status ON capabilities(kind,status);
CREATE INDEX IF NOT EXISTS idx_reputation_identity ON reputation_events(identity_id,created_at);
CREATE INDEX IF NOT EXISTS idx_demand_status_score ON demand_signals(status,score);
