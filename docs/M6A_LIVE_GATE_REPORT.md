# ATLAS M6A / M6B Live Gate Report

Generated from verified GitHub Actions evidence on 2026-10-01.

## 1. Migration Proof — PASS for safety, NOT READY for historical import

- Source export fingerprint: 281 rows; 267 keyed; 266 unique; 14 missing idempotency keys; one duplicate key `req|2arj8z`; checksum `96f47d6dfcfbffaf`.
- The production import gate is fail-closed.
- The generic importer was hardened so `atlas_execution_state` cannot dedupe, overwrite, or silently discard missing/duplicate-key rows.
- CI test PASS after the hardening.
- No historical CSV rows have been imported into production.
- The 14 anomalous rows and the duplicate pair remain preserved for a later explicit historical disposition.

## 2. D1 Proof — PASS

Latest live read-only audit:
- Database: `atlas_db`
- D1 database ID: `a5a75faa-e800-4112-b67a-3c53d7b0d8d4`
- Live table count reported by Wrangler: 13
- BountyBook nonce table is now part of the schema and exists live.
- Live row counts observed: `event_log=0`, `execution_state=2`, `ceo_memory=0`, `order_ledger=0`, `delivery_outbox=0`, `bridge_audit=0`, `bountybook_auth_nonces=0`.
- The two execution-state rows are live Worker state produced by the scheduled system, not the historical CSV import:
  - `report|2026-10-01` / `atlas_report` / `SENT`
  - `watch|bb|completed` / `revenue_watch_state` / `WATCHING`
- D1 Time Travel returned a current bookmark during the audit.
- No restore operation was performed.

## 3. Functional Proof — PARTIAL PASS

Verified against the deployed Worker:
- `/health` returns `ok=true` and `db=ok`.
- `/dev/state` is not publicly exposed (404).
- Telegram webhook without configuration fails closed (503).
- Order webhook without configuration fails closed (503).
- ChatGPT bridge without configuration fails closed (503).
- Current live provider modes reported by `/health`: AI/Brave/Telegram/Email/Payment = MOCK.
- Full real-provider end-to-end delivery is therefore not proven.

## 4. Provider Proof — BLOCKED / NOT PROVEN

No provider has been switched to LIVE.
Real Telegram, OpenRouter, payment, email, and external-provider execution remain intentionally disabled/locked.

This is a safety boundary, not a test failure.

## 5. Cron Proof — PARTIAL PASS

- `wrangler.toml` contains three Cron Triggers:
  - `0 21 * * *`
  - `*/30 * * * *`
  - `*/15 * * * *`
- The deployed Worker has a `scheduled()` handler.
- Live D1 state proves scheduled business logic has executed.
- Exact Cloudflare Cron Event inventory was not asserted because the current API token lacks the required Workers deployment-read scope.
- No trigger was changed during this audit.

## N8N EXIT

n8n remains active and has NOT been removed from the execution path.

The exit gate remains closed because these are still unproven:
- historical execution-state migration,
- real provider proof,
- Telegram cutover,
- complete external dependency proof,
- exact deployment/trigger inventory,
- rollback rehearsal,
- final production parity.

No n8n shutdown, deletion, payment activation, wallet signing, or production Worker deployment was performed by this audit.
