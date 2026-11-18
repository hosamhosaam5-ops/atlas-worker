# ATLAS Clean v1 — Phase 2 production specification (design only)

**Status: SPECIFICATION ONLY — NOT APPROVED FOR DEPLOYMENT.**  
This document defines the proposed production path and its gates. It does not create a workflow, change a wallet, create a secret, set a route, deploy a Worker, perform a payment, or update an external evidence card.

## 1. Verified repository state

The following is based on source files in the current repository revision:

| Item | Verified state |
|---|---|
| Production Wrangler config | `wrangler.clean-v1.toml` names the script `atlas-clean-v1`, uses `src/clean-v1/worker.js`, sets `workers_dev = false` and `preview_urls = false`. |
| Trial Wrangler config | `wrangler.clean-v1-trial.toml` names a separate script `atlas-clean-v1-trial` and sets `workers_dev = true`. |
| Production route | No `routes` or `custom_domains` entry is present in `wrangler.clean-v1.toml`. A public production URL/route is therefore **UNKNOWN**. |
| Data bindings | The Clean v1 production config has no D1 binding. The Worker code does not persist uploaded files or cleaned outputs. |
| Runtime endpoints | The code exposes `GET /health`, preview endpoints, and paid `POST /x402/clean_v1`. It is a standalone HTTP/x402 Worker, not an A2A JSON-RPC endpoint. |
| Facilitator | `FACILITATOR_URL` is a non-secret Wrangler variable, currently defaulting to `https://facilitator.openx402.ai`. Live facilitator readiness is **UNKNOWN**. |
| Payment configuration | `src/clean-v1/payment.js` contains the static `PAYMENT_CONFIG.payTo`, Base network `eip155:8453`, USDC asset, `exact` scheme, EIP-3009, upfront flow, and amount `10000` base units. |
| Health provenance | Current `/health` returns service identity and mode, but not a deployed Git SHA. Deployment-SHA verification is not currently implemented. |

The currently committed `payTo` value is a code value, not proof that it matches the owner's latest approved receiving wallet. That match is **UNKNOWN** and must be explicitly confirmed by the owner before any production payment route is enabled.

## 2. Proposed production workflow

Create a dedicated workflow:

`/.github/workflows/atlas-clean-v1-production-deploy.yml`

Do **not** reuse `.github/workflows/atlas-worker-deploy.yml` or `.github/workflows/production-deploy.yml` as-is: both deploy the default `wrangler.toml` Worker configuration, not the standalone `wrangler.clean-v1.toml` target.

Proposed controls:

1. Trigger only by `workflow_dispatch` on `main`. No automatic `push` deploy trigger and no deploy-marker file.
2. Require a GitHub Environment such as `clean-v1-production` with an owner-controlled required reviewer. The existence and protection settings of such an Environment are **UNKNOWN**.
3. Check out one immutable approved commit SHA and assert the Wrangler config names exactly `atlas-clean-v1` and points to `src/clean-v1/worker.js`.
4. Run locked dependency installation, the complete local test suite, Clean v1 payment/failure tests, and `wrangler deploy --dry-run --config wrangler.clean-v1.toml`.
5. Verify that only the allowlisted Worker name is targeted. Capture the pre-deployment Worker version/deployment metadata and the route mapping before any write.
6. Deploy once, explicitly specifying `--config wrangler.clean-v1.toml`; never fall back to the default `wrangler.toml`.
7. Verify the selected production route with `GET /health` (HTTP 200), the expected service identity, preview behavior, and an unpaid paid-route request returning HTTP 402 with the expected x402 challenge. Do not send a real payment as a smoke test.
8. Record the exact source SHA and Cloudflare deployment/version identifier. Before release, add a non-secret immutable release-SHA value to the Worker health response or prove an equivalent version-to-SHA mapping from Cloudflare deployment metadata. Current health output does not provide this proof.
9. Fail closed if the config, route, token, wallet, or deployed version does not match the reviewed values.

The exact production URL, route/domain, TLS readiness, and whether a route should be a custom domain or a Workers Route are all **UNKNOWN**. The owner must choose and approve that public endpoint before the config or workflow is implemented.

## 3. Cloudflare access token decision

### Existing token usage

- `CF_TRIAL_API_TOKEN` is referenced by `.github/workflows/cloudflare-clean-v1-trial.yml`. That workflow uses it for trial-resource preflight, a one-time deploy of `atlas-clean-v1-trial`, Analytics reads, and cleanup. It maps the value to the Wrangler environment variable `CLOUDFLARE_API_TOKEN` only inside that trial workflow.
- `CLOUDFLARE_API_TOKEN` is used by existing workflows for the current `atlas-worker` deployment and live audit. The actual token scopes and resource restrictions are not visible in repository source.
- No current workflow deploys production `atlas-clean-v1`.

### Required design

Do not treat the trial token as a production credential. Its technical ability to deploy `atlas-clean-v1` is **UNKNOWN** because the token's Cloudflare permissions have not been inspected, and no such inspection is authorized in this phase.

The proposed workflow should use a distinct GitHub Actions secret, for example `CF_CLEAN_V1_PROD_API_TOKEN`, with the least Cloudflare permissions needed for the approved target only:

- Workers Scripts read/write for the target account and deployment operation.
- The minimum route/custom-domain permission required by the owner's selected routing model.
- No D1, database, billing, DNS-wide, or unrelated Worker permissions unless a separately approved and justified requirement is documented.

The exact Cloudflare permission labels and whether a token can be restricted to one script rather than an account-wide scope must be verified by the owner in Cloudflare's settings before provisioning. This document does not create or inspect any token. The existing `CLOUDFLARE_API_TOKEN` must not be reused automatically; its effective scope is **UNKNOWN**.

## 4. Receiving wallet and payment configuration

The single current source-code location is `PAYMENT_CONFIG.payTo` in `src/clean-v1/payment.js`. The address is public configuration, not a private key or secret, and should not be copied into a GitHub Actions secret.

Before release:

1. The owner confirms the exact current ATLAS receiving address in writing.
2. A separate reviewed PR changes `PAYMENT_CONFIG.payTo` only if the committed value differs from that confirmed address.
3. Tests prove that the x402 requirement's `payTo` and the signed authorization's `to` both match the same approved value.
4. The docs and evidence record identify the network, USDC contract, raw amount, and approved receiver consistently.
5. No test sends funds. Live facilitator behavior, transaction settlement, network fees, processor deductions, refunds, and net proceeds remain **UNKNOWN** until separately authorized and evidenced.

The current configured amount is `10000` USDC base units (0.01 USDC at six decimals) on Base `eip155:8453`. This is a configured request amount, not evidence of a real charge or net receipt.

## 5. Evidence records and cards

Keep internal evidence append-only and SHA-linked. After a verified production deployment, add a new record such as `docs/clean-v1-production-evidence.md` containing:

- approved source commit SHA and PR/CI URLs;
- production deployment workflow run URL and Cloudflare version/deployment ID;
- exact Worker name and owner-approved route;
- health response status and release-SHA match;
- unpaid x402 challenge result (HTTP 402);
- live settlement state explicitly marked **UNKNOWN** unless a real, owner-authorized transaction has verifiable evidence;
- any failed deployment and rollback record, retaining the original failed run and SHA.

The existing `docs/commerce-acceptance-evidence-2026-10-22.md` must not be rewritten to imply commercial acceptance. Add a dated Clean v1 subsection only when the cited evidence exists. Do not turn passing tests, public health, preview responses, or a configured price into customer, revenue, paid-order, or settlement claims.

The current repository contains an existing ATLAS commercial-evidence document and manual Agent Card/Registry verification workflows, but no dedicated Clean v1 evidence-card identifier, external card URL, or card-provider API was established during this read-only inspection. Those external card details are **UNKNOWN**.

The existing Clean v1 Worker only exposes HTTP/x402 routes; it does not implement the A2A JSON-RPC protocol. Therefore do not add it as an A2A skill or publish a new Registry entry unless a reviewed A2A adapter/interface is built and verified first. Any public Agent Card, Registry, marketplace, or evidence-card update is a separate owner-approved publication step after the production endpoint and offer are proven. No public card is updated by the proposed deployment workflow.

## 6. Failure handling and recovery

### Before deployment

- Capture the last-known-good Worker version/deployment ID, current route mapping, config SHA, source SHA, and workflow run URL.
- Preserve the production config and route as reviewed artifacts.
- Confirm that Clean v1 remains isolated and has no D1, KV, Queue, R2, or other persistence binding.
- Do not begin while the route or approved receiving wallet is unresolved.

### If deployment or verification fails

1. Stop further deployment attempts. Do not retry automatically.
2. Keep the failed run, deployment identifier, source SHA, and sanitized output for diagnosis.
3. Restore service by sending traffic back to the captured last-known-good Worker version, or by deploying the last-known-good source SHA again with the same explicit Clean v1 config. Do not deploy the default ATLAS Worker config as a substitute.
4. Restore the exact prior route mapping if and only if the route was changed by the failed release. This is a production write and requires the owner's approval.
5. Re-check health, source/version identity, preview behavior, and unpaid HTTP 402 behavior after recovery.
6. Append a `ROLLED_BACK` evidence entry; do not delete the failed deployment, logs, or evidence record.

Cloudflare's exact version rollback command/API, the account's ability to revert traffic to a prior version, and the token permission required for that operation are **UNKNOWN** and must be validated in a non-production rehearsal before production use.

### Data and payment boundary

The current Clean v1 implementation is stateless and has no D1 binding, so a code rollback has no application database state to restore. The Worker does not persist uploaded files or cleaned results. Any customer-visible response or on-chain payment that already completed cannot be undone by a code rollback. Refund capability, facilitator refund support, and fee reversibility are **UNKNOWN**; any refund or customer commitment requires an explicit owner decision.

## 7. Explicit unknowns and approval gates

| Item | Status |
|---|---|
| Production script currently exists in Cloudflare | **UNKNOWN** — no account read is performed in this phase. |
| Production public URL / route / custom domain | **UNKNOWN** — absent from current production Wrangler config. |
| Whether `CF_TRIAL_API_TOKEN` can technically write the production script | **UNKNOWN** — token scopes not inspected; do not reuse it by default. |
| Effective scope of existing `CLOUDFLARE_API_TOKEN` | **UNKNOWN**. |
| Existence of protected GitHub Environment and required reviewers | **UNKNOWN**. |
| Owner-approved current receiving wallet matches the committed `payTo` | **UNKNOWN**. |
| Live facilitator availability, settlement, replay behavior, fees, refunds, and net receipt | **UNKNOWN**. |
| Exact Cloudflare rollback operation and permission | **UNKNOWN**. |
| External evidence-card provider, identifiers, URLs, and update API | **UNKNOWN**. |
| A2A adapter for Clean v1 | **Not implemented**. |

**No deployment, Cloudflare account/API access, payment, production write, D1 access, or evidence-card update is authorized by this specification.** Each such action remains separately gated by explicit owner approval.
