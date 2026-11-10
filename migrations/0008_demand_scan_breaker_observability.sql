-- Additive per-scan snapshot of the existing source circuit breaker state.
-- Nullable to preserve historical rows and represent unavailable health snapshots.
ALTER TABLE demand_scan_source_runs ADD COLUMN breaker_state TEXT;
ALTER TABLE demand_scan_source_runs ADD COLUMN consecutive_failures INTEGER;
ALTER TABLE demand_scan_source_runs ADD COLUMN cooldown_ms INTEGER;
