# ATLAS Clean v1 — Phase 2 production deployment and recovery

**Status: IMPLEMENTED IN A DORMANT PR; NOT DEPLOYED OR ARMED.** The production deployment workflow is manual-only, defaults to read-only preflight, and refuses deployment unless the owner changes the marker to the exact approved content. No Cloudflare resource, route, secret, payment, production Worker, or evidence card is changed by this PR.

## 1. Isolated deployment target

The deployment workflow is:

- .github/workflows/atlas-clean-v1-production-deploy.yml
- Worker configuration: wrangler.clean-v1.toml
- Worker name: atlas-clean-v1
- Entrypoint: src/clean-v1/worker.js

The workflow has **no pull_request, push, or schedule trigger**. It runs only through workflow_dispatch. Its default mode is preflight; the deploy mode is separate.

The deploy command is pinned to the dedicated config:

~~~sh
npx --no-install wrangler deploy --config wrangler.clean-v1.toml
~~~

A dry run uses the same config:

~~~sh
npx --no-install wrangler deploy --dry-run --config wrangler.clean-v1.toml
~~~

A static test checks that the workflow only invokes these commands against wrangler.clean-v1.toml, the config name is atlas-clean-v1, the entrypoint is src/clean-v1/worker.js, and the config contains no D1, atlas_db, route, or custom-domain binding. The workflow does not read or deploy wrangler.toml, does not invoke the main atlas-worker deployment workflow, and does not change production routes.

The committed Clean v1 config has workers_dev = false and preview_urls = false; it currently has no routes or custom_domains entry. Therefore a reachable production URL is **UNKNOWN**. Before activation, the owner must establish the intended route/custom domain and provide its HTTPS base URL as the base_url dispatch input or the CLEAN_V1_PROD_BASE_URL repository variable. The workflow only validates and uses that URL; it never creates or changes the route. If route setup is needed, the owner must do it separately and approve the zone-level permission.

## 2. Owner activation gate

Default marker:

ops/triggers/clean-v1-production.trigger

~~~text
DISARMED
~~~

The deployment step is allowed only when the marker is exactly three lines:

~~~text
RUN
OWNER_CONFIRMED_CLEAN_V1_WALLET

~~~

The third line must be empty. A marker with any other content is treated as disarmed. The deployment is not triggered by a commit or marker push; the owner must manually dispatch the workflow on main and explicitly choose mode=deploy. The default dispatch mode preflight cannot deploy. This avoids conflict with the repository-wide [skip ci] merge rule and prevents a marker commit from deploying by itself.

The owner must first state **«فعّل الإنتاج»** and confirm that the committed receiving wallet is the approved current ATLAS wallet. No marker arming or deploy dispatch is part of this PR.

## 3. Token usage and permissions

The workflow reuses the existing GitHub Actions secret CF_TRIAL_API_TOKEN; it creates no token or secret and never prints the token value.

### Read-only preflight

The default preflight mode performs only:

1. GET /user/tokens/verify to confirm the token is active.
2. GET /accounts/{account_id}/workers/scripts to read Worker metadata and determine whether atlas-clean-v1 already exists.
3. A read-only Cloudflare GraphQL Analytics query to confirm Analytics access and inspect the CPU quantile unit.

It prints only HTTP statuses, token-active/read-permission results, whether the target Worker exists, and the specific permissions still unproven. It does not upload code, update a Worker, create a route, delete a resource, or send a payment.

### What read-only preflight cannot prove

A successful GET does not prove that the token has write authorization. The deploy permission remains **UNKNOWN** until an owner-authorized deployment operation is eventually performed.

Cloudflare's documented minimum deployment roles are:

- If atlas-clean-v1 already exists: **Workers Editor** scoped to that Worker or to the Workers product.
- If atlas-clean-v1 does not exist yet: **Workers product Admin** is required to create the Worker. Per-Worker roles cannot grant access to a Worker that does not yet exist.
- Analytics after the five-minute wait requires **Account → Account Analytics → Read**.
- This workflow does not change a Route or Custom Domain. If the owner separately chooses to create/change one, Cloudflare requires **Workers Routes Write** for every affected zone in addition to the Worker role.

The preflight will report a missing read permission if it receives 401/403. It deliberately reports the deployment write permission as **UNKNOWN**, even when token verification and metadata reads succeed. It must not claim that CF_TRIAL_API_TOKEN is sufficient for production deploy merely because the isolated trial used it successfully in the past.

Cloudflare references:
- https://developers.cloudflare.com/workers/authorization/workers/
- https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/

## 4. Deployment-time checks

Only after the owner gate is satisfied, the workflow:

1. Revalidates wrangler.clean-v1.toml and the isolated entrypoint.
2. Requires an owner-provided HTTPS base_url; it does not guess a production URL.
3. Installs locked dependencies and runs npm test.
4. Reads the current deployment inventory when available, preserving the output for diagnosis. If the target has no previous deployment or the inventory cannot be read, it records that the rollback baseline is UNKNOWN.
5. Runs the dedicated-config Wrangler dry run, then one deploy of atlas-clean-v1.
6. Reads back deployment status.
7. Runs an isolated-service health check and confirms service=atlas-clean-v1.
8. Calls GET /x402/clean_v1/preview, then preview POSTs containing 10 and 200 synthetic CSV rows. The 200-row request must return a preview capped at 10 output rows with truncated=true.
9. Calls POST /x402/clean_v1 without payment authorization and requires HTTP 402 plus PAYMENT-REQUIRED. It sends no PAYMENT-SIGNATURE and no funds.
10. Waits five minutes, then reads Cloudflare Analytics for atlas-clean-v1: CPU quantile schema/unit, invocation status counts, HTTP response status counts, errors, and any status indicating exceeded CPU/resources. If there are no rows or Analytics is unavailable, the result is explicitly UNKNOWN; no value is inferred.

process.cpuUsage() is only the local Node benchmark. The deployment workflow's Cloudflare Analytics query is a separate, read-only measurement. CPU quantiles are reported in microseconds only when the API schema description confirms that unit.

## 5. Receiving wallet

The source location is:

PAYMENT_CONFIG.payTo in src/clean-v1/payment.js.

The address is committed public configuration, not a GitHub secret. This PR does not change it. Before activation, the owner must compare that value with the current approved ATLAS receiving wallet. If it differs, a separate owner-reviewed code PR is required; do not replace it silently.

The configured payment is Base eip155:8453, USDC, exact, EIP-3009 upfront settlement, and 10000 base units. These code settings are not proof of live facilitator readiness, fees, settlement, a customer payment, or net revenue. All of those remain UNKNOWN until separately authorized and evidenced.

## 6. Manual stop and rollback

There is no production cleanup/delete workflow. The existing .github/workflows/cloudflare-clean-v1-cleanup.yml is limited to the isolated trial script name atlas-clean-v1-trial; the static test asserts that it does not target the production script atlas-clean-v1.

The production stop mechanism is a separate manual workflow:

.github/workflows/atlas-clean-v1-production-stop.yml

It has only workflow_dispatch, requires an explicit version_id, and is protected by:

ops/triggers/clean-v1-production-stop.trigger

Default content is DISARMED. It runs only when the owner explicitly arms the three-line marker:

~~~text
ROLLBACK
OWNER_CONFIRMED_CLEAN_V1_ROLLBACK

~~~

The action calls Wrangler rollback for --name atlas-clean-v1 with the dedicated wrangler.clean-v1.toml config and a specifically selected version ID. It does not delete the Worker or connected resources.

### Exact read and rollback commands

Run these only in an owner-authorized workflow/runner with the existing CF_TRIAL_API_TOKEN injected securely into CLOUDFLARE_API_TOKEN; do not paste or print the token:

~~~sh
npx --no-install wrangler deployments list --name atlas-clean-v1 --json --config wrangler.clean-v1.toml
~~~

Select a known-good version ID from that inventory, then:

~~~sh
npx --no-install wrangler rollback "$KNOWN_GOOD_VERSION_ID" --name atlas-clean-v1 --config wrangler.clean-v1.toml --message "Owner-approved Clean v1 manual rollback"
~~~

Verify the active deployment:

~~~sh
npx --no-install wrangler deployments status --name atlas-clean-v1 --json --config wrangler.clean-v1.toml
~~~

Cloudflare documents that wrangler rollback [VERSION_ID] --name atlas-clean-v1 --message ... creates a new deployment with the selected prior version and routes 100% of the Worker's traffic to it. Rollback does not restore or alter connected resources. Keep the failed version, workflow logs, and run IDs; do not delete them.

**First-deployment limitation:** if no prior version exists, there is no known-good version to roll back to. In that case the stop workflow cannot produce a safe rollback. The owner must manually detach/disable the preconfigured route in Cloudflare, which requires Workers Routes Write for the affected zone. Do not delete the Worker as a substitute.

## 7. Owner actions still required

Before saying **«فعّل الإنتاج»**, the owner must:

1. Confirm the current PAYMENT_CONFIG.payTo value matches the approved receiving wallet.
2. Decide and configure the production HTTPS route/custom domain; set/provide CLEAN_V1_PROD_BASE_URL. The current config itself has no route.
3. Review the read-only token preflight. Confirm the existing CF_TRIAL_API_TOKEN has the required Workers Editor/Admin role and Account Analytics Read. The current deploy write role remains UNKNOWN until an authorized deployment; no new token is created.
4. Only after those confirmations, set the exact activation marker and manually dispatch mode=deploy.
5. Keep the production stop marker DISARMED unless a separate owner-authorized rollback is required.

## 8. Explicit unknowns

| Item | Current status |
|---|---|
| Whether the production Worker already exists | **UNKNOWN** until read-only preflight. |
| Existing Worker deployment/version inventory | **UNKNOWN** until preflight. |
| Current production URL, route, custom domain, and TLS readiness | **UNKNOWN**; none is configured in wrangler.clean-v1.toml. |
| Whether the current CF_TRIAL_API_TOKEN has Workers Editor/Admin | **UNKNOWN**; the read-only preflight cannot prove write authorization. |
| Whether it has Account Analytics Read today | **UNKNOWN** until preflight. |
| Owner-approved receiving wallet matches PAYMENT_CONFIG.payTo | **UNKNOWN** until owner confirmation. |
| Live facilitator settlement, replay, fees, refunds, and net proceeds | **UNKNOWN**. |
| A previously deployed known-good version for rollback | **UNKNOWN** until deployment inventory is read. |
| External evidence-card provider/identifier/API | **UNKNOWN**; no evidence card is updated by this workflow. |

**This PR leaves both production markers DISARMED. It performs no deployment, no payment, no evidence-card publication, and no automatic production cleanup.**
