-- ATLAS P1 agent-native interoperability. Additive and idempotent.
CREATE TABLE IF NOT EXISTS agent_webhooks (
 webhook_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, url TEXT NOT NULL, events_json TEXT NOT NULL DEFAULT '[]',
 status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_tasks (
 task_id TEXT PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'SUBMITTED',
 input_json TEXT NOT NULL DEFAULT '{}', output_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);
CREATE TABLE IF NOT EXISTS customer_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, entity_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}',
 status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_webhooks_agent ON agent_webhooks(agent_id,status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status,created_at);