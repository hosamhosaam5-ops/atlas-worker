# ATLAS Clean v1 — gated production operations

**Status: implementation proposal only. Not activated, not deployed, and not approved for production use.**

This PR adds the workflow code and guardrails only. It does not create or modify Cloudflare resources, create secrets, set GitHub Environment variables, change routes, move the activation marker, perform a payment, or update an evidence card.

## 1. Current production target

- Dedicated Worker name: `atlas-clean-v1`.
- Entry point: `src/clean-v1/worker.js`.
- Deployment config: `wrangler.clean-v1.toml`.
- The workflow invokes only `npx --no-install wrangler deploy --config wrangler.clean-v1.toml`.
- It does not use `wrangler.toml`, `src/index.ts`, the primary `atlas-worker` script, D1, or `atlas_db`.
- `MAX_ROWS` remains 200.
- The production config currently sets `workers_dev = false`, `preview_urls = false`, and has no `routes` or `custom_domains` entry. Therefore the public production URL and route are **UNKNOWN** until the owner selects and provisions one. The manual stop workflow deletes only the exact Worker script; if a Workers Route or Custom Domain is provisioned separately, its route/domain binding must be checked and detached as a separate owner-approved action. The stop workflow does not guess zone IDs or delete route records.

The deploy job requires the GitHub Environment variables:
- `CLEAN_V1_PROD_BASE_URL`: HTTPS origin for the owner-approved route, without a path/query.
- `CLEAN_V1_APPROVED_WALLET`: public receiving address confirmed by the owner.

These are variables, not secrets. This PR does not create or populate them. The deploy job fails before running Wrangler if either is missing or the approved wallet does not match the committed `PAYMENT_CONFIG.payTo`.

## 2. Activation gate

The deploy workflow has only `workflow_dispatch`; it has no `push` or `pull_request` event. Committing or changing the marker cannot start a deployment.

File: `ops/triggers/clean-v1-production.trigger`

Current contents:

```text
DISARMED
```

The deploy job requires exactly three lines:

1. `RUN`
2. `OWNER_CONFIRMED_CLEAN_V1_WALLET`
3. blank

Any other contents—including the current one-line `DISARMED` value—produce `CLEAN_V1_PRODUCTION_GATE=DISARMED` and skip deployment. The marker is never changed by the workflow.

The deploy job also references the GitHub Environment `clean-v1-production`. Before activation, the owner must configure required reviewers/protection rules for that Environment and set the two non-secret variables above. The existence and current protection settings of that Environment are **UNKNOWN**; no Environment configuration was changed in this PR.

## 3. Existing Cloudflare token — read-only verification and exact permission boundary

The workflow reuses only the existing GitHub Actions secret `CF_TRIAL_API_TOKEN`. No new secret is created and no secret value is displayed.

On a future manual dispatch, even while the marker is DISARMED, the separate preflight job performs read-only requests:
- `GET /accounts/{account_id}/workers/scripts?per_page=1` to check that the token can read the Workers Scripts list. The Cloudflare OpenAPI spec lists accepted permission groups for this endpoint, including `Workers Scripts Read`, `Workers Scripts Write`, `Workers Admin`, `Workers Editor`, `Workers Content Read-Only`, and `Workers Metadata Read-Only`.
- A read-only Cloudflare GraphQL query to verify that Workers Analytics schema/quantiles can be read. The Workers role model maps legacy `Workers Observability Read` to `Metadata Read-Only` at Workers product scope.

It prints only the HTTP status and PASS/FAIL markers, not the response body, token, or script list. Deployment requires both read-only checks to pass.

**Important limitation:** these checks only prove read access. They do not test whether the token can create/upload/delete a Worker. Whether `CF_TRIAL_API_TOKEN` currently has the required write permissions is **UNKNOWN** because token scopes were not inspected and no write probe is permitted.

### Exact permission requirements

Cloudflare's current Workers authorization model (last updated 2026-09-15) distinguishes creating a new Worker from updating an existing one:

- **Create a Worker that does not yet exist:** requires product-level `Workers Admin`. A per-Worker role cannot authorize a resource that does not yet exist.
- **Upload/update an existing Worker:** `Workers Editor` at the selected Worker or Workers product scope is the current role for deployment. The upload API's accepted token groups include `Workers Scripts Write`, `Workers Admin`, `Workers Editor`, `Individual Workers Admin`, and `Individual Workers Editor`. However, per-Worker roles only apply after the Worker exists; they do not satisfy first-time creation.
- **Delete the exact Worker in the manual stop workflow:** the DELETE API accepts `Workers Scripts Write`, `Workers Admin`, or `Individual Workers Admin`. The Editor role does not include deletion.
- **Read Workers Analytics:** use `Metadata Read-Only` at Workers product scope (legacy permission name: `Workers Observability Read`).
- **Change a Workers Route or Custom Domain:** requires `Editor` access to the Worker plus `Workers Routes Write` for each affected zone. This PR does not configure or change any route.

The API's accepted permission groups are not proof that this account's token has any of those permissions. A successful read-only preflight must never be interpreted as proof of create, upload, delete, or route-write access.

References:
- [Workers roles, scopes, Wrangler permissions, and API token access](https://developers.cloudflare.com/workers/authorization/workers/)
- [Workers authorization overview](https://developers.cloudflare.com/workers/authorization/)
- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Upload Worker API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
- [Workers Scripts API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/)

**Conclusion for this repository:** `CF_TRIAL_API_TOKEN` sufficiency remains **UNKNOWN**. If `atlas-clean-v1` does not already exist, the exact create permission needed is product-level `Workers Admin`. For a Worker that already exists, upload/deploy requires `Workers Editor` (or an upload API token group such as `Workers Scripts Write`). The future manual cleanup requires one of the DELETE permission groups above. Do not create another token or change permissions without owner approval.

## 4. Deployment sequence after explicit owner approval

Only after the owner says **"فعّل الإنتاج"** and confirms that the current receiving wallet is correct:

1. Owner configures the protected GitHub Environment, public `CLEAN_V1_PROD_BASE_URL`, and `CLEAN_V1_APPROVED_WALLET`.
2. Owner confirms Cloudflare token permissions and that the public route already maps to the isolated `atlas-clean-v1` target. This workflow does not create or alter a route.
3. Owner changes the activation marker to the exact three-line gate and manually dispatches `ATLAS Clean v1 production deploy (owner-gated)` on `main`.
4. The workflow runs the local test suite, the static isolation checks, and Wrangler dry-run before the single deployment command. It makes one deploy attempt and does not automatically retry.
5. After deployment, the probe runs:
   - a valid query-based `GET /x402/clean_v1/preview` with one sample row;
   - `POST /x402/clean_v1/preview` with 10 rows;
   - `POST /x402/clean_v1/preview` with 200 rows;
   - an unpaid `POST /x402/clean_v1` which must return HTTP 402 and a challenge matching the approved wallet.

The unpaid check sends no body, `PAYMENT-SIGNATURE`, or payment transaction. It must not contact the facilitator or send funds.

6. The workflow waits 300 seconds after the smoke tests, then reads Workers Analytics for `atlas-clean-v1`. It reports the CPU quantile unit (only converts when schema explicitly says microseconds), raw p50/p99 values, invocation status counts, HTTP status counts, and resource-overrun status/counts. If Analytics returns no rows or permission is unavailable, it reports **UNKNOWN** and fails the measurement step rather than claiming zero overruns.

The current URL/route, whether the trial token can create the new script, whether the Environment is protected, and live Analytics visibility are **UNKNOWN**. This PR does not execute any of these steps.

## 5. Wallet location and owner action

The receiving address is configured in source at:

`src/clean-v1/payment.js` → `PAYMENT_CONFIG.payTo`

It is public payment configuration, not a private key. The workflow compares it to `CLEAN_V1_APPROVED_WALLET` and refuses to deploy if they differ. Do not update this value or the owner variable based on historical wallet notes. The owner must confirm the exact current receiving address before activation. The activation marker's second line is an explicit confirmation gate; it is not a replacement for comparing the actual address.

## 6. Manual stop / cleanup

The existing `.github/workflows/cloudflare-clean-v1-cleanup.yml` remains isolated to `atlas-clean-v1-trial`; it is not changed.

Production cleanup is a separate workflow:
`.github/workflows/cloudflare-clean-v1-production-cleanup.yml`

It has only `workflow_dispatch`; there is no `push`, `pull_request`, or schedule trigger. Its distinct marker is:

`ops/triggers/clean-v1-production-cleanup.trigger`

Current contents:

```text
DISARMED
```

To issue a future manual stop, the owner must set exactly three lines:

1. `STOP`
2. `OWNER_CONFIRMED_STOP_CLEAN_V1_PRODUCTION`
3. blank

Then the owner must manually dispatch `ATLAS Clean v1 production stop (manual only)` on `main`. It checks the exact script name, deletes only `atlas-clean-v1`, then performs a fresh GET to verify that exact Worker is absent. It never runs automatically after a deploy or a merge. It does not delete any separately configured zone Route or Custom Domain; those must be reviewed and detached by the owner if such a route was provisioned. This future deletion step requires an owner-authorized action; it has not been run and both markers remain DISARMED in this PR.

## 7. Rollback commands

Before any future deployment, capture the last known-good version and deployment IDs:

```bash
npx --no-install wrangler versions list --config wrangler.clean-v1.toml --json
npx --no-install wrangler deployments list --config wrangler.clean-v1.toml --name atlas-clean-v1 --json
```

Select and record the version ID that is currently known-good. If post-deploy checks fail and a previous good version exists, the owner can restore it with:

```bash
npx --no-install wrangler rollback <LAST_GOOD_VERSION_ID> --config wrangler.clean-v1.toml --message "Rollback atlas-clean-v1 to last known good version"
```

This command creates a new deployment and sends 100% of traffic to the selected version across that Worker's routes/domains; it is a production write and must be run only after the owner approves the specific version ID. A rollback does not modify connected resources. Clean v1 currently has no D1/database binding.

If this is the first-ever deployment and no last-good version exists, the rollback command cannot restore a prior version. The owner must use the separately gated manual stop workflow after confirming the exact target. Do not substitute the default `wrangler.toml` or deploy the primary `atlas-worker` as a rollback.

References:
- [Wrangler versions and rollback commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [Cloudflare Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

## 8. Explicitly unverified

| Item | Status |
|---|---|
| CF_TRIAL_API_TOKEN can read Workers Scripts | **UNKNOWN** until the new workflow's read-only preflight is run on `main`. |
| CF_TRIAL_API_TOKEN can read Workers Analytics | **UNKNOWN** until the new workflow's read-only preflight is run on `main`. |
| CF_TRIAL_API_TOKEN can create `atlas-clean-v1` / upload script content | **UNKNOWN**; requires Workers product-level Admin to create a new Worker and Workers Scripts Write (or equivalent editor/admin permission) for upload. |
| Public production hostname/route | **UNKNOWN**; no route/custom domain is present in `wrangler.clean-v1.toml`. |
| GitHub Environment protection/required reviewers | **UNKNOWN**. |
| Owner's latest receiving wallet equals committed `payTo` | **UNKNOWN** until owner confirmation. |
| Live facilitator settlement, fees, refunds, or net proceeds | **UNKNOWN**; no payment is attempted here. |
| Exact deployed Worker/version in Cloudflare | **UNKNOWN**; no Cloudflare call or deploy was performed in this PR. |

No new secret, route, Cloudflare resource, production deployment, payment, evidence-card update, or marker activation is part of this PR.
