# ATLAS n8n Exit Gate — M6A

This document is a fail-closed checklist. n8n must remain unchanged and operational until every REQUIRED gate is independently evidenced.

## Current state (2026-09-29)
- Latest repository CI baseline: GitHub Actions run 36602523347 completed SUCCESS on commit 040bcc8.
- A newer validation run is pending after the importer mapping fix; its result must be checked before declaring the new commit green.
- n8n archive reported by the operator: 27 workflows, 20 exported in full, 12 Data Tables, 23 credentials (secret values excluded).
- Reported live n8n dependencies: Telegram CEO trigger, public ZATCA form, daily/revenue/Telegraph workflows, bridges.
- Reported state requiring disposition: 281 execution-state rows, 25 CEO-memory rows, marketing/publication/watch data, quotes/test orders.
- No production deployment or n8n shutdown is authorized by this file.

## Required gates
1. **Archive integrity**: all 27 workflow inventories reconciled; full JSON/source retained; missing historical workflows explicitly listed.
2. **Data inventory**: every one of the reported 12 Data Tables has an exact name, row count, export checksum, disposition, and migration/archive status.
3. **Functional state**: active CEO state/agent/task/report semantics are either implemented in Worker or explicitly classified LEGACY_ONLY with preserved archive. No silent loss.
4. **Migration proof**: schema migrations apply cleanly to empty D1; data imports are validated, deduplicated, idempotent, and count/checksum verified.
5. **Provider proof**: MOCK tests green; LIVE providers are not called unless explicitly approved. LIVE readiness is distinct from LIVE integration proof.
6. **Telegram cutover proof**: webhook secret configured and one founder-approved real delivery confirms Worker outbox SENT. Do not claim this from MOCK.
7. **Cron proof**: Worker schedules are present and handlers are idempotent; do not activate production until deployment approval.
8. **Public ZATCA form**: either intentionally retired with a replacement or kept as an explicitly documented legacy dependency.
9. **Payment**: remain frozen; no real transaction or signing is required for exit.
10. **Secrets**: no secret values in Git; Worker secret names documented only.
11. **External dependency scan**: no production endpoint, callback, webhook, or published asset still requires n8n unless intentionally retained.
12. **Rollback**: n8n remains available until post-cutover verification and a documented rollback window completes.

## Hard stop conditions
- Missing/unverified export data.
- Unknown external dependency.
- Any failing CI test.
- Any provider result inferred rather than observed.
- Any migration that can silently drop or overwrite source rows.
- Any need for a production deployment, real payment, or wallet signature without explicit founder approval.

## Exit criterion
n8n can be considered outside the ATLAS execution path only after all REQUIRED gates above are PASS and the remaining n8n assets are explicitly archived/retired with no live dependency.
