# M6A execution-state migration disposition

Source fingerprint: `96f47d6dfcfbffaf`
Source rows: 281
Keyed rows: 267
Unique idempotency keys: 266
Missing idempotency keys: 14
Duplicate keys: 1

## Production disposition

FAIL-CLOSED. No production import is authorized by this manifest.

### Duplicate key — requires explicit row-level reconciliation

| id | idempotency_key | correlation_id | created_at |
|---:|---|---|---|
| 3 | `req|2arj8z` | `req_1789830058409` | 2026-09-19T15:00:58.444Z |
| 4 | `req|2arj8z` | `req_1789830066257` | 2026-09-19T15:01:06.278Z |

Both rows are `action_result` / `calculator` / `SUCCEEDED` and have the same result payload. They must not be silently collapsed.

### Missing idempotency keys — quarantine/reconciliation required

| id | record_kind | action_id | tool | status | entity_type | entity_id |
|---:|---|---|---|---|---|---|
| 313 | *(empty)* | `kaggle_dataset_upload` | `kaggle_api` | BLOCKED | dataset_publication | `hosaam961/de-lu-spot-prices-sample-2500` |
| 316 | revenue_watch_state | *(empty)* | *(empty)* | WATCHING | *(empty)* | *(empty)* |
| 317 | revenue_watch_state | *(empty)* | *(empty)* | WATCHING | *(empty)* | *(empty)* |
| 318 | revenue_watch_state | *(empty)* | *(empty)* | WATCHING | *(empty)* | *(empty)* |
| 319 | revenue_watch_state | *(empty)* | *(empty)* | WATCHING | *(empty)* | *(empty)* |
| 320 | revenue_watch_state | *(empty)* | *(empty)* | WATCHING | *(empty)* | *(empty)* |
| 321 | revenue_watch_state | *(empty)* | *(empty)* | WATCHING | *(empty)* | *(empty)* |
| 322 | revenue_watch_state | *(empty)* | *(empty)* | WATCHING | *(empty)* | *(empty)* |
| 323 | revenue_watch_state | *(empty)* | *(empty)* | WATCHING | *(empty)* | *(empty)* |
| 324 | revenue_watch_state | *(empty)* | *(empty)* | WATCHING | *(empty)* | *(empty)* |
| 325 | revenue_watch_state | *(empty)* | *(empty)* | WATCHING | *(empty)* | *(empty)* |
| 326 | revenue_watch_state | *(empty)* | *(empty)* | WATCHING | *(empty)* | *(empty)* |
| 327 | revenue_watch_state | *(empty)* | *(empty)* | WATCHING | *(empty)* | *(empty)* |
| 328 | revenue_watch_state | *(empty)* | *(empty)* | WATCHING | *(empty)* | *(empty)* |

No synthetic idempotency key is assigned. No row is discarded. The rows remain outside the production `execution_state` import until their correct historical representation is established.
