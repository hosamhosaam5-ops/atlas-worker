Capture a read-only D1 Time Travel restore point and baseline counts. No database writes or restores are performed by this workflow.

Parser retry trigger: 2026-10-30; no D1 writes.

Direct metadata verification and bookmark retrieval parser correction: 2026-10-30; read-only.

Node 22 async IIFE wrapper fix: 2026-10-30; no D1 writes.

Echo the complete step summary to the job log for auditable bookmark and baseline review; read-only.

Remove the account identifier from workflow environment output; resolve exactly one account through Wrangler identity JSON without printing it. Read-only.

Log hygiene hardening: move inline Node code to checked script files; keep job log output to the approved allowlist only; rerun baseline capture.

Runtime correction: use native ESM imports for Node 22 and validate the post-0006 production baseline (10 demand_signals columns, 23 rows) before emitting only allowlisted fields.
