# D1 Restore Points

## 2026-10-30 — production baseline

- **Workflow run:** [ATLAS D1 restore point #5](https://github.com/hosamhosaam5-ops/atlas-worker/actions/runs/40967790826)
- **Main commit:** `457a54f5a0a90b17c0d1803d0a89cdf30445359d`
- **Captured:** 2026-10-29 22:42:24 UTC (2026-10-30 01:42:24 Asia/Riyadh)
- **D1 backend:** `production` (verified in the same run)
- **Time Travel bookmark (captured inside this run):** `00002850-00000000-00005113-1853133781d65d579f24f27e2f3a719f`
- **demand_signals:** 8 columns; 23 rows.

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
