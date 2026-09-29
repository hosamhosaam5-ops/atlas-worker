-- ATLAS Worker — M3 additions: bridges + crons.
-- Only tables proven required by the actual backup code are added.

-- ChatGPT Bridge audit log (backup: data table atlas_bridge_audit, id 5qLJgkP2TBJP2Tzb)
CREATE TABLE IF NOT EXISTS bridge_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  operation TEXT,
  status TEXT,
  auth_result TEXT,
  timestamp TEXT,
  error_summary TEXT
);

-- ZATCA experiment requests (backup data table 1H1qOwaJr7vI5ljN; read by Daily Report + Telegraph Monitor)
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

-- Acquisition assets (backup jky7P9UDsJXX20l5; read by Daily Report)
CREATE TABLE IF NOT EXISTS acquisition_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset TEXT,
  status TEXT,
  created_at TEXT
);

-- Channel watch (backup 1d8qDK4d5Q8Yc0um; read by Daily Report)
CREATE TABLE IF NOT EXISTS channel_watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT,
  verdict TEXT,
  status TEXT,
  check_date TEXT
);

-- Publications (backup D4JkDNFIse7k9m4D; read by Daily Report)
CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT,
  asset TEXT,
  status TEXT,
  publication_time TEXT
);

CREATE INDEX IF NOT EXISTS idx_zatca_req_time ON zatca_experiment_requests(submitted_at);
CREATE INDEX IF NOT EXISTS idx_bridge_audit_ts ON bridge_audit(timestamp);
