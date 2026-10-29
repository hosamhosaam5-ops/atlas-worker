-- Phase 1: additive demand observability schema.
-- Safe to apply once through Wrangler D1 migrations. No destructive statements.
ALTER TABLE demand_signals ADD COLUMN source_url TEXT;
ALTER TABLE demand_signals ADD COLUMN last_verified_at TEXT;

CREATE TABLE IF NOT EXISTS demand_scan_source_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id TEXT NOT NULL,
  source TEXT NOT NULL,
  raw_count INTEGER NOT NULL DEFAULT 0,
  raw_recent_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  rejection_counts_json TEXT NOT NULL DEFAULT '{}',
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  response_ms INTEGER,
  http_status INTEGER,
  source_status TEXT NOT NULL,
  error_code TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scan_id, source)
);

CREATE INDEX IF NOT EXISTS idx_demand_scan_source_runs_source_started
  ON demand_scan_source_runs(source, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_demand_scan_source_runs_scan
  ON demand_scan_source_runs(scan_id);

CREATE TABLE IF NOT EXISTS demand_source_health (
  source TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'CLOSED',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT,
  next_probe_at TEXT,
  cooldown_ms INTEGER NOT NULL DEFAULT 900000,
  last_status INTEGER,
  last_error_code TEXT,
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_http_status INTEGER,
  last_response_ms INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_demand_source_health_state
  ON demand_source_health(state, next_probe_at);
