# D1 Migration State

## 0006 — demand observability

<badge>APPLIED AND VERIFIED</badge>

- **Migration file:** `migrations/0006_demand_observability.sql`
- **File SHA-256:** `f21ae747825004f663f32f9535186f0f0c3905f5649f5d4cdedcd52772ae80ef`
- **Execution workflow:** [ATLAS D1 apply migration 0006 — run #40969071483](https://github.com/hosamhosaam5-ops/atlas-worker/actions/runs/40969071483)
- **Main commit:** `e27bcba4eeb33c306f65fa1e06695e2ced4fe5ef`
- **Applied:** 2026-10-29 22:52 UTC (2026-10-30 01:52 Asia/Riyadh)

### Pre-write controls

- Time Travel bookmark captured in the same workflow run: `00002851-00000000-00005113-aad111985a1c637c6df1934a81701428`
- Captured at: 2026-10-29 22:52:17.086 UTC (2026-10-30 01:52:17.086 Asia/Riyadh)
- Same-run identity and age-under-two-hours guards passed before preflight and again immediately before execution.
- Read-only preflight passed: `demand_signals` had 8 columns and 23 rows; `demand_scan_source_runs` and `demand_source_health` were absent.

### Execution

- The workflow executed only `migrations/0006_demand_observability.sql` using `wrangler d1 execute atlas_db --remote --file=...`.
- Wrangler reported 7 SQL statements executed; no row contents were selected or logged.
- No `wrangler d1 migrations apply` command was run.
- The migration SQL does not reference or modify `d1_migrations`.
- No delete, rollback, or Time Travel restore was performed.

### Post-write verification

- `demand_signals`: **10 columns**; the added columns `source_url` and `last_verified_at` are present.
- `demand_signals` rows: **23** (unchanged from preflight).
- `demand_scan_source_runs`: **present**.
- `demand_source_health`: **present**.
- Production `/health`: **HTTP 200**.
- Wrangler reported post-execution bookmark: `00002851-00000006-00005113-a7cd7a6f993e972913df05a7e46ca15a`.

### Independent read-only confirmation

After the workflow completed, a separate Cloudflare D1 read-only query confirmed:
- 10 `demand_signals` columns, including both new columns.
- 23 `demand_signals` rows.
- Both new tables exist.
- Reference row counts remained: `event_log` 542, `order_quotes` 143, `order_ledger` 122, `execution_state` 346, `ceo_memory` 101, `bridge_audit` 60, `order_files` 250, `delivery_outbox` 217.
- The read-only query reported `rows_written=0` and `changed_db=false`.

No Time Travel restore was performed. The pre-write bookmark remains a recovery reference only.
