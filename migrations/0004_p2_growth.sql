-- ATLAS P2 growth and acquisition layer. Additive and idempotent.
CREATE TABLE IF NOT EXISTS growth_runs (
 run_id TEXT PRIMARY KEY, status TEXT NOT NULL, signals_found INTEGER NOT NULL DEFAULT 0,
 actions_ready INTEGER NOT NULL DEFAULT 0, partner_signals INTEGER NOT NULL DEFAULT 0,
 started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT, detail_json TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS growth_assets (
 asset_id TEXT PRIMARY KEY, asset_type TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
 title TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PUBLISHED',
 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS growth_referrals (
 id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, path TEXT, user_agent TEXT, source TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS growth_partners (
 partner_key TEXT PRIMARY KEY, name TEXT, endpoint TEXT, source TEXT,
 status TEXT NOT NULL DEFAULT 'DISCOVERED', metadata_json TEXT DEFAULT '{}',
 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_growth_runs_started ON growth_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_referrals_code ON growth_referrals(code,created_at);
