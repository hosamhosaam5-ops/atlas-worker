# ATLAS M6A migration evidence

Source: preserved `atlas_execution_state.csv` export retained outside the repository.

Verified locally on 2026-10-01:
- Source rows: **281**
- Rows with idempotency_key: **267**
- Unique idempotency keys: **266**
- Rows missing idempotency_key: **14**
- Duplicate idempotency keys: **1** (`req|2arj8z`, occurring twice)
- Deterministic full-export checksum: **96f47d6dfcfbffaf**

## Safety decision

The 14 rows without an `idempotency_key` are not eligible for the `execution_state` migration contract because that column is the D1 primary key. They must not be fabricated, silently discarded, or assigned guessed keys.

The duplicate key must be reconciled by the migration policy before production import. The current importer’s `ON CONFLICT(idempotency_key) DO UPDATE` is therefore **not accepted as migration proof**, because it can replace existing state.

This document is evidence only. It does not claim that D1 migration or Cloudflare deployment has occurred.
