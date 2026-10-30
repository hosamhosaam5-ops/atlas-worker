# D1 Migration State

## 0006 — demand observability

**Status: APPLIED AND VERIFIED**

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


## Demand signal stale-status transition

**Status: EXECUTED; POSTFLIGHT AND INDEPENDENT READ VERIFIED**

- **Workflow run:** [ATLAS D1 mark stale #40970819358](https://github.com/hosamhosaam5-ops/atlas-worker/actions/runs/40970819358)
- **Workflow commit:** `ea96e84b64a04aa862c5169852f4c8e99a79dc92`
- **Same-run bookmark:** `00002854-00000000-00005113-9cd34670169f89112262f17a0a58c9e3`
- **Captured:** 2026-10-29 23:06:54.914 UTC (2026-10-30 02:06:54.914 Asia/Riyadh)
- **Freshness at write:** less than 5.4 seconds; the post-update verification step began at 23:07:00.302 UTC.
- **Preflight:** the helper requires exactly 23 scoped rows and all 23 to be `QUALIFIED`; the preflight step completed successfully.
- **Only SQL executed:**

```sql
UPDATE demand_signals
SET status='STALE_UNVERIFIED'
WHERE id BETWEEN 1 AND 23
  AND source='opentask_public_tasks'
  AND status='QUALIFIED';
```

- **Postflight:** 23 scoped rows `STALE_UNVERIFIED`; 0 scoped rows `QUALIFIED`; total `demand_signals` rows 23.
- **Independent read-only D1 confirmation:** the same 23/0/23 counts; 0 duplicate `signal_key` values; 0 rows currently outside the exact scope.
- **updated_at:** the allowlisted UPDATE does not reference or modify `updated_at`; the independent read showed the existing timestamps unchanged by this SQL.
- **Rollback:** the automatic rollback workflow was skipped because the mark-stale run completed successfully. No Time Travel restore was performed.

**Change-count evidence limitation:** the helper did not emit Wrangler's `meta.changes` value into the job log. The run proves successful execution of the single allowlisted UPDATE and its 23-row postflight; the independent D1 query confirms the resulting state. This document does not invent a separately logged `changes` counter.

### Production growth read after transition

The authenticated production `growth_snapshot` returned 23 `STALE_UNVERIFIED` signals and no `QUALIFIED` signals. Its historical action aggregate still exposed 23 `QUALIFIED_LEAD / READY` rows, so PR #172 added current-status filtering to the snapshot and live status checks to offer preparation and negotiation. PR #172 is merged, but its production deployment is pending a founder-triggered deployment workflow; until deployed, the production snapshot may still show those historical actions. No D1 action rows were changed.


## Production release — demand observability, circuit breaker, and verified-source counting gate

**Status: DEPLOYED AND HEALTH-VERIFIED**

- **Merged implementation PRs:** [#169 per-source scan observability](https://github.com/hosamhosaam5-ops/atlas-worker/pull/169), [#173 persistent circuit breaker and AgentJob 60-second poll gate](https://github.com/hosamhosaam5-ops/atlas-worker/pull/173), [#174 verified original-source counting gate](https://github.com/hosamhosaam5-ops/atlas-worker/pull/174), and [#172 stale-offer visibility and negotiation guard](https://github.com/hosamhosaam5-ops/atlas-worker/pull/172).
- **Production deployment workflow:** [ATLAS Production Deploy #40973569516](https://github.com/hosamhosaam5-ops/atlas-worker/actions/runs/40973569516)
- **Deployed main commit / verified Worker `git_sha`:** `6cabe6d97f233abecb644dfb710625ec1f5ec7a8`
- **Deployment health verification:** HTTP 200; `ok=true`; `db=ok`; deployed `git_sha` matched the exact tested commit.
- **Pre-deploy test job:** 220 tests passed; 0 failed.
- **Post-deploy ATLAS health tool:** `ok=true`, database `ok`, Telegram `LIVE`.

### First post-deploy source-scan evidence

A read-only D1 query after deployment found four per-source scan metric rows. The query itself reported `rows_written=0` and `changed_db=false`.

| Existing source | Raw | Recent | Accepted | Rejected | Duplicates | HTTP | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `agent_job_public_mcp` | 50 | 1 | 0 | 50 | 0 | 200 | OK |
| `opentask_public_tasks` | 26 | 5 | 0 | 26 | 0 | 200 | OK |
| `agent_souk` | 0 | 0 | 0 | 0 | 0 | 200 | OK |
| `payanagent_open_requests` | 0 | 0 | 0 | 0 | 0 | 500 | HTTP_ERROR |

- `demand_source_health`: AgentJob, Agent Souk, and OpenTask were `CLOSED` with zero consecutive failures; PayanAgent was `CLOSED` with one consecutive failure and `HTTP_500`. The configured three-failure circuit-breaker threshold was not reached.
- Production `growth_snapshot` after deployment: `actions=[]`; the only existing demand signals remained 23 `STALE_UNVERIFIED`; no `QUALIFIED` signal was counted.
- The latest completed growth-cycle row returned by `growth_snapshot` at the time of this record was still the pre-deployment 23:30:40–23:30:47 UTC cycle. The first post-deploy source scan completed at 23:33:02 UTC; a later scheduled growth cycle is still required to establish post-deploy cycle completion.
- No new sources, scoring thresholds, qualification criteria, or 30-day age conditions were introduced. No customer contact or spending occurred.

### Corrective release — restore approved three-failure circuit policy

**Status: DEPLOYED AND SHA-VERIFIED**

- **Corrective PR:** [#181 — revert unauthorized PayanAgent circuit threshold exception](https://github.com/hosamhosaam5-ops/atlas-worker/pull/181); merged after ATLAS CI, ATLAS tests, live Agent Card audit, quality-strategy checks, and manual review passed.
- **Production deployment:** [ATLAS Production Deploy #40976434004](https://github.com/hosamhosaam5-ops/atlas-worker/actions/runs/40976434004); the complete test suite passed before deployment.
- **Production /health:** `ok=true`, `db=ok`; Worker `git_sha` equals `d316ecaf996cf6acadd2dd6f5d75fa30349613dc`, the deployed/main commit at verification.
- **Circuit behavior restored:** all sources, including PayanAgent, retain the three-consecutive-transient-failure threshold; first and second failures keep the circuit CLOSED, third failure opens it. The 15-minute initial cooldown, exponential backoff to six hours, Retry-After handling for HTTP 429, and AUTH_REQUIRED treatment for 401/403 remain unchanged.
- No D1 migration or direct D1 data write was part of this corrective release.

### Seven-day qualification observation window

**Status: NOT STARTED — no start/end timestamp is authorized**

- PR #177 had recorded 2026-10-29 23:31:22 UTC as the start based on health verification. That timestamp was superseded by [PR #179](https://github.com/hosamhosaam5-ops/atlas-worker/pull/179) and must not be counted.
- Current release: production/main SHA `d316ecaf996cf6acadd2dd6f5d75fa30349613dc`, verified in [Production Deploy #40976434004](https://github.com/hosamhosaam5-ops/atlas-worker/actions/runs/40976434004).
- The only conditions for starting the seven-day window are: (1) main SHA and production `/health` `git_sha` match; (2) at least two complete growth cycles finish after the current deployment, with source rows in both `demand_scan_source_runs` and corresponding updates in `demand_source_health`; (3) production evidence demonstrates the persisted 60-second AgentJob gate using two real attempts in the log, with the second rejected or deferred; and (4) the cycles have no cycle-level errors. Any source-level errors must be listed separately and must not be represented as successful reads.
- The latest direct production D1 read found **1 post-deployment growth run**, `growth_ca700330c00c403b9ea8`, `COMPLETED`, from `2026-10-30 00:00:40` to `00:00:43 UTC`, with `signals_found=0`, `actions_ready=0`, and `partner_signals=0`. One cycle does not meet the requirement for two.
- Its source scan ID is `71a5ec65-b732-4060-b911-d3d91ec7a385`, started `2026-10-30T00:00:40.833Z`, finished `00:00:43.089Z`, with 4 source rows. The four `demand_source_health` rows were updated at `2026-10-30T00:00:40.326Z`. This scan has one source-level error: PayanAgent returned HTTP 500 (`HTTP_ERROR`, 723 ms). The overall growth-run row is `COMPLETED`, but this is not a fully error-free source scan.
- The immediately preceding scan ID `f172f52b-908a-4112-ac57-661891e41715` finished at `2026-10-29T23:45:48.620Z`, before the current deployment. The older scan `3ada58a3-461c-4bb1-8bb6-e43c133468eb` finished at `23:33:02.183Z`; it also predates the current deployment.
- The persisted AgentJob gate is not yet proven by a real blocked attempt. Its latest recorded attempts are `2026-10-29T23:45:41.064Z` and `2026-10-30T00:00:40.326Z`, about 15 minutes apart. All three visible AgentJob scan rows are `OK`; no production `POLL_GATE`/deferred row is present. Unit-test coverage is not a substitute for production-log evidence.
- **Approved circuit behavior was observed in D1:** three consecutive PayanAgent HTTP 500s were recorded in scan IDs `3ada58a3-461c-4bb1-8bb6-e43c133468eb`, `f172f52b-908a-4112-ac57-661891e41715`, and `71a5ec65-b732-4060-b911-d3d91ec7a385`. The latest health row is `state=OPEN`, `consecutive_failures=3`, `cooldown_ms=900000`, `last_http_status=500`, and `next_probe_at=2026-10-30T00:15:40.326Z`. This confirms the approved three-failure threshold and 15-minute initial cooldown; no failures were artificially triggered.
- Automation `6ae3d78f03388191a23a1cfe70d4dea5` remains **PRE-WINDOW — NOT COUNTED**. Its run history is empty and delivery status is unknown. Any pre-gate summaries do not count.
- **Start timestamp: not set. End timestamp: not set.** Only a reviewed PR may set these after all four conditions above have been evidenced with the current deployed SHA, two qualifying growth-cycle IDs and scan IDs/row counts, no cycle errors, and real AgentJob gate evidence.
- Last verified demand baseline remains 23 `STALE_UNVERIFIED` signals, 0 qualified signals, and 0 new accepted items. No source, scoring rule, original-source verification requirement, or 30-day age limit has changed.

No Time Travel restore was performed.
