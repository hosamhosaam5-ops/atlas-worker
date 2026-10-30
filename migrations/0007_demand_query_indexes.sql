-- Add the six approved demand-query indexes.
-- This migration is additive and does not update or delete existing rows.
CREATE INDEX IF NOT EXISTS idx_capabilities_kind_status
  ON capabilities(kind, status);

CREATE INDEX IF NOT EXISTS idx_reputation_identity
  ON reputation_events(identity_id, created_at);

CREATE INDEX IF NOT EXISTS idx_demand_status_score
  ON demand_signals(status, score);

CREATE INDEX IF NOT EXISTS idx_growth_actions_status
  ON growth_actions(status, created_at);

CREATE INDEX IF NOT EXISTS idx_engineering_jobs_status
  ON engineering_jobs(status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_demand_signal_key
  ON demand_signals(signal_key);
