# Clean v1 workflow-trigger incident — 2026-11-17

## Summary

**Incident:** the merge of commit `d772b2a817734ee4fcfd31cf7559489d3699a8e7` caused the `atlas-live-audit` workflow to run because the merge commit did not contain `[skip ci]` and the commit changed a file under `docs/**`.

**Workflow:** [run #44133197500](https://github.com/hosamhosaam5-ops/atlas-worker/actions/runs/44133197500)  
**Workflow source:** [`.github/workflows/atlas-live-audit.yml`](../.github/workflows/atlas-live-audit.yml), blob SHA `41a47cdff7aeb6a4bc6d1d4a3cee1b20b9c0da1f`  
**Commit:** [`d772b2a817734ee4fcfd31cf7559489d3699a8e7`](https://github.com/hosamhosaam5-ops/atlas-worker/commit/d772b2a817734ee4fcfd31cf7559489d3699a8e7)

The run metadata reported `event=push`, `head_branch=main`, `head_sha=d772b2a817734ee4fcfd31cf7559489d3699a8e7`, `status=completed`, and `conclusion=success`. The pushed commit message had no `[skip ci]` marker. The workflow's `push.branches` filter is `main`, and its `push.paths` list explicitly contains `docs/**`.

## What the run accessed

The single `live-audit` job completed successfully. Its steps and logs show:

- Cloudflare Cron schedule read: HTTP 200.
- Worker secret listing: metadata only; secret values were not printed.
- D1 database metadata read: HTTP 200.
- D1 SQL audit: read-only `SELECT` statements against `sqlite_master` and row counts; log markers `D1_SQL_READ_AUDIT=PASS` and `D1_READ_ONLY_AUDIT=PASS`.
- D1 Time Travel bookmark read: HTTP 200; `D1_TIME_TRAVEL_READ_AUDIT=PASS`.
- Public Worker health `GET`: returned HTTP 200 and JSON with `git_sha=19c0c000c37bcad50009114aed6cf49f41d2797a`, not the pushed commit SHA.
- Unauthenticated production smoke requests were rejected: Telegram HTTP 403, order HTTP 403, and ChatGPT bridge HTTP 401.
- Base RPC checks were read-only: `BASE_RPC_FAIL_CLOSED=PASS`; the positive recent-window gate was `NOT_PROVABLE_WITHOUT_AN_EXISTING_INCOMING_PAYMENT`; a pre-existing on-chain USDC receipt was used only as a parser fixture, with no transaction broadcast.
- The unauthenticated MCP initialize probe returned HTTP 401.

## Impact and non-impact

**Confirmed access:** Cloudflare account metadata, D1 read APIs/SELECT queries, public Worker health/authentication endpoints, Base RPC read methods, and unauthenticated MCP discovery.

**No write or deployment observed:** the D1 statements in the job were `SELECT` only; unauthenticated Worker requests were rejected with 401/403; no Wrangler deploy step or successful production mutation appears in the workflow job; no payment was sent or broadcast. The workflow's deployment-inventory step explicitly reported that exact inventory was unverified.

This was therefore an unintended production-adjacent **read-only audit**, not a production deployment or a database write. The fact that requests were read-only does not make the trigger acceptable under the owner's no-Cloudflare/no-production constraint.

## Cause

The commit title and body for `d772b2a...` omitted `[skip ci]`. The audit's `docs/**` path filter matched the documentation change, so GitHub started the `push` workflow on `main`.

The repository's current trigger is unchanged. This record does not modify workflow behavior.

## Permanent merge guard

For every future merge to `main`, except an explicitly owner-approved trial-marker arming commit:

1. The merge commit title **and** body must each contain `[skip ci]`.
2. Before merging, inspect every workflow's `on:` section and path filters against every changed PR path, including `docs/**`.
3. Verify that the skip marker is in the actual merge commit message, not merely the PR title or PR description.
4. Confirm the intended workflow behavior after merge from GitHub run metadata; do not infer suppression from the PR's text.

GitHub documents that skip instructions suppress workflows triggered by `push` and `pull_request` when the marker is in the pushed commit message or PR HEAD commit. They do **not** suppress `workflow_dispatch`, `schedule`, or other event types. A skipped workflow's associated required checks can remain pending, so PR validation must run before the merge commit is created.

Official reference: [GitHub Actions — Skipping workflow runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs).

## Evidence commands and raw results

Read-only GitHub API requests used to verify the run:

- `GET /repos/hosamhosaam5-ops/atlas-worker/actions/runs/44133197500`  
  Raw fields: `event=push`, `head_sha=d772b2a817734ee4fcfd31cf7559489d3699a8e7`, `path=.github/workflows/atlas-live-audit.yml`, `conclusion=success`.
- `GET /repos/hosamhosaam5-ops/atlas-worker/actions/runs/44133197500/jobs`  
  Raw job: `live-audit`, `conclusion=success`; steps include the Cron, D1 read-only, Worker auth smoke, Base RPC, and MCP probes listed above.
- `GET /repos/hosamhosaam5-ops/atlas-worker/actions/jobs/134215565284/logs`  
  Raw markers include `Cloudflare Cron schedule API HTTP=200`, `D1_DATABASE_METADATA_READ=PASS`, `D1_SQL_READ_AUDIT=PASS`, `D1_READ_ONLY_AUDIT=PASS`, `D1_TIME_TRAVEL_READ_AUDIT=PASS`, `telegram unauthenticated status=403`, `order unauthenticated/unconfigured status=403`, `chatgpt unauthenticated status=401`, `BASE_RPC_FAIL_CLOSED=PASS`, and `BASE_RPC_POSITIVE_REAL_RECEIPT=PASS`.

No production deployment, database write, or payment is claimed or inferred from this audit.
