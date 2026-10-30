# Guarded production-only D1 migration execution instructions.
# This trigger is the sole path allowlisted by .github/workflows/d1-apply-0007.yml.
EXPECTED_WORKER_SHA=4ff23367ba4f3d27646bcf840c79c63de8a8a33e
EXPECTED_GROWTH_RUN_ID=growth_7f0055c97cf94a2aa806
EXPECTED_SCAN_ID=6f21c1e3-cd0e-47c1-a2f2-434784d983cf

Apply only migrations/0007_demand_query_indexes.sql to the exact production database atlas_db (UUID a5a75faa-e800-4112-b67a-3c53d7b0d8d4) using wrangler d1 execute --remote --file after the allowlisted preflight succeeds. Require a fresh same-run Time Travel bookmark younger than two hours, captured once and rechecked immediately before execution. Preflight requires the exact healthy production Worker SHA above; the recorded COMPLETED growth run and four-source scan rows above; demand_signals = 10 columns and 23 rows; signal_key NULL count = 0; duplicate groups = 0; and all six target indexes absent with no equivalent indexes. Postflight verifies all six exact definitions and column order, idx_demand_signal_key unique, all table row counts unchanged, and /health ok=true/db=ok with the same Worker SHA. Do not run migrations apply, do not touch d1_migrations, and do not write any other SQL. On any preflight or postflight failure, stop and retain the state; do not auto-drop indexes, delete records, or run a restore. No Time Travel restore is authorized.
