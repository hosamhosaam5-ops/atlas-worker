# D1 Restore Points

## 2026-10-30 — production baseline

- **Workflow run:** [ATLAS D1 restore point #5](https://github.com/hosamhosaam5-ops/atlas-worker/actions/runs/40968213651)
- **Main commit:** `08252f5130ac600dddfeec57822da052f1e4e9bb`
- **Captured:** 2026-10-29 22:45:52 UTC (2026-10-30 01:45:52 Asia/Riyadh)
- **D1 backend:** `production` (verified in the same run)
- **Time Travel bookmark (captured inside this run):** `00002850-00000000-00005113-1853133781d65d579f24f27e2f3a719f`
- **demand_signals:** 8 columns; 23 rows.
- **Bookmark note:** The same bookmark was returned by the preceding successful capture because no D1 writes or state changes occurred between captures; this bookmark was fetched again inside run #40968213651.

### Reference row counts

| Table | Rows |
| --- | ---: |
| event_log | 542 |
| order_quotes | 143 |
| order_ledger | 122 |
| execution_state | 346 |
| ceo_memory | 101 |
| bridge_audit | 60 |
| order_files | 250 |
| delivery_outbox | 217 |

### Additional inspected tables

| Table | Result |
| --- | ---: |
| zatca_experiment_requests | 0 |
| acquisition_assets | 0 |
| channel_watch | 0 |
| publications | 0 |
| bountybook_auth_nonces | 0 |
| demand_signals | 23 |
| demand_scan_source_runs | absent |
| demand_source_health | absent |

### Time Travel retention

**Actual retention for this Cloudflare account: unverified.** Cloudflare's current D1 Time Travel documentation states that Workers Free supports 7 days and Workers Paid supports 30 days. The account's active Workers plan was not independently verified, so neither duration is asserted as this account's effective retention.

Source: [Cloudflare D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/) (accessed 2026-10-30).

### Safety

- This workflow performed read-only metadata and SQL inspection.
- No D1 writes, migrations, deletes, exports, or Time Travel restores were performed.
- The bookmark is a recovery reference only; no restore is authorized by this record.


## 2026-10-30 — post-0006 production baseline

- **Workflow run:** [ATLAS D1 restore point #40972146308](https://github.com/hosamhosaam5-ops/atlas-worker/actions/runs/40972146308)
- **Workflow commit:** `7e5767d91bd6d16831f41c260068cf2fd57e87a4`
- **Captured:** 2026-10-29 23:18:30.164 UTC (2026-10-30 02:18:30.164 Asia/Riyadh)
- **D1 backend:** `production` (verified in the same run)
- **Time Travel bookmark (captured inside this run):** `00002855-00000012-00005113-77e0d6b4f379666f816595e80bf25216`
- **demand_signals:** 10 columns; 23 rows.

### Reference row counts

| Table | Rows |
| --- | ---: |
| event_log | 542 |
| order_quotes | 143 |
| order_ledger | 122 |
| execution_state | 346 |
| ceo_memory | 101 |
| bridge_audit | 60 |
| order_files | 250 |
| delivery_outbox | 217 |

### Additional inspected tables

| Table | Result |
| --- | ---: |
| zatca_experiment_requests | 0 |
| acquisition_assets | 0 |
| channel_watch | 0 |
| publications | 0 |
| bountybook_auth_nonces | 0 |
| demand_signals | 23 |
| demand_scan_source_runs | 0 |
| demand_source_health | 0 |

### Time Travel retention

**Actual retention for this Cloudflare account: unverified.** Current Cloudflare documentation lists 7 days for Workers Free and 30 days for Workers Paid. The account's active Workers plan was not independently verified; therefore this record does not assert either duration as the account's effective retention.

Source: [Cloudflare D1 limits — Time Travel duration](https://developers.cloudflare.com/d1/platform/limits/) (accessed 2026-10-30). See also [Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/).

### Safety

- The run verified the production backend, captured a new bookmark, and performed read-only schema/count queries.
- The job log printed only the bookmark, demand_signals column/row counts, and approved table counts.
- No D1 writes, migrations, deletes, exports, or Time Travel restores were performed by this restore-point run.
- The bookmark is a recovery reference only; no restore is authorized by this record.
