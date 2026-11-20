# ATLAS Clean v1 — Evidence Card Update Package

**Prepared:** 2026-11-20  
**Purpose:** Owner-reviewable text and evidence for future directory-card updates. This file does not publish or edit any external listing.

## Public service card

**Name:** ATLAS Clean v1  
**Service URL:** https://atlas-clean-v1.hosamhosaam5.workers.dev  
**Paid operation:** one successful paid clean call  
**Price:** 0.01 USDC per call  
**Network:** Base — eip155:8453  
**Asset:** USDC  
**USDC contract (source configuration):** 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  
**Receiving wallet:** 0x59Ea688b36464133E71873d8BeE8Fcb3BC369383  
**Input limit:** 100 KiB  
**Maximum input rows:** 200  
**Free preview:** first 10 cleaned rows; preview is available at GET/POST /x402/clean_v1/preview  
**Paid endpoint:** POST /x402/clean_v1  
**Payment protocol:** x402 v2, exact scheme, upfront EIP-3009 transfer authorization

The amount is stored in src/clean-v1/payment.js as the literal `amount: '10000'`. With USDC's six decimal places, this is 0.01 USDC. The configured asset address is identical to the contract address supplied by the owner for comparison with the facilitator's supported-network listing. A direct GET read of https://facilitator.openx402.ai/supported was unavailable during this preparation; independent live verification of the facilitator's current supported list is therefore **UNKNOWN**.

## Production evidence — deployment run #5

Run: [ATLAS Clean v1 production deployment #5](https://github.com/hosamhosaam5-ops/atlas-worker/actions/runs/44722347797)  
Commit: a3bfd188f8691f0ad27b55eda43760144a70a5d6  
Result: success; resolve-trigger, read-only-preflight, and deploy all completed successfully.

Observed production probe output:

```text
CLEAN_V1_HEALTH_HTTP=200
CLEAN_V1_HEALTH_SERVICE=atlas-clean-v1
PREVIEW_GET_HTTP=200
PREVIEW_GET_SOURCE_ROWS=1
PREVIEW_POST_10_HTTP=200
PREVIEW_POST_10_SOURCE_ROWS=10
PREVIEW_POST_10_RETURNED_ROWS=10
PREVIEW_POST_200_HTTP=200
PREVIEW_POST_200_SOURCE_ROWS=200
PREVIEW_POST_200_RETURNED_ROWS=10
PREVIEW_POST_200_TRUNCATED=true
UNPAID_CLEAN_HTTP=402
PAYMENT_REQUIRED_HEADER=PRESENT
PAYMENT_RESPONSE_HEADER=ABSENT
REAL_PAYMENT_SENT=false
CLEAN_V1_PROD_PROBE=PASS
```

This verifies health and preview behavior and confirms that an unpaid request receives HTTP 402. It does **not** prove a live payment or completed paid-clean operation.

## Published version history

The production deployment logs recorded these versions in chronological order:

| Order | Version ID | Published at (UTC) | Distribution evidence |
|---|---|---|---|
| 1 | 0776cca2-645a-4af0-97d2-0810d77199c2 | 2026-11-19 14:33:08 | 100% in Wrangler deployment status after the first upload |
| 2 | 8be92ba7-596c-43ea-b835-36fd7649a833 | 2026-11-20 10:49:46 | 100% in Wrangler deployment status from run #5; current at that run |

The second version superseded the first in the deployment evidence. Retain both IDs for audit and rollback investigation; do not infer that rollback was tested.

## Analytics evidence from run #5

Measurement time: 2026-11-20T10:49:48Z. The workflow waited five minutes before reading Analytics.

```text
CPU_QUANTILE_SCHEMA={"cpuTimeP50":"CPU time 50th percentile - microseconds","cpuTimeP99":"CPU time 99th percentile - microseconds"}
CPU_QUANTILE_UNIT=MICROSECONDS
CLEAN_V1_ANALYTICS_RAW=[{"datetime":"2026-11-20T10:49:48Z","status":"success","httpResponseStatus":200,"requests":4,"errors":0,"cpuTimeP50":1110,"cpuTimeP99":4268},{"datetime":"2026-11-20T10:49:48Z","status":"success","httpResponseStatus":402,"requests":1,"errors":0,"cpuTimeP50":1110,"cpuTimeP99":1110}]
ANALYTICS_TOTAL_REQUESTS=5
ANALYTICS_TOTAL_ERRORS=0
INVOCATION_STATUS_COUNTS={"success":5}
HTTP_RESPONSE_STATUS_COUNTS={"200":4,"402":1}
RESOURCE_OVERRUN_STATUSES=[]
RESOURCE_OVERRUN_REQUESTS=0
CLEAN_V1_ANALYTICS=READ_ONLY_COMPLETE
```

The reported CPU quantiles are in microseconds. These are aggregate Analytics records for the measured window, not an endpoint-by-endpoint CPU profile.

## What has not been measured

- **Full paid-path cleaning CPU:** not measured. The production probe deliberately sent no payment; therefore the full paid clean operation was not executed in this measurement.
- **Live settlement:** not measured. No real payment was made and no live settlement transaction hash was produced by this run.
- **Fees and net proceeds:** not measured. No fee schedule, facilitator charge, network fee, or net proceeds were established.
- **Real customer conversion/revenue:** not measured. An HTTP 402 challenge and a successful preview are not a sale.
- **5xx rate outside the measured window:** UNKNOWN. The Analytics sample above reports zero errors for five requests in its window; it is not a complete historical error-rate claim.

## Directory update eligibility — read-only review

No accounts were created, no identity was submitted, and no external card was changed. The following statuses distinguish a public submission from management of an existing listing.

| Directory | Can an existing listing be updated without an account or identity? | Evidence-based note |
|---|---|---|
| Agenstry | **UNKNOWN** | Public cards are shown with ownership-claim/verification controls, including DNS TXT or linked GitHub proof. Updating the source Agent Card at its own host may change discovered metadata, but no confirmed account-free edit procedure for this existing Agenstry record was verified. References: https://agenstry.com/agents/api.strale.io and https://agenstry.com/agents/dev.emblemvault.ai |
| A2A Registry | **NO for direct management** | The public site says an agent URL can be submitted without an account, but claiming and managing an existing listing requires a free account. DNS TXT or GitHub linking is used for the verified badge. Reference: https://www.a2a-registry.org/ |
| Agent402 | **UNKNOWN** | Its FAQ says no account or API key is needed to consume tools; that does not establish how an agent publisher edits a listing. Reference: https://agent402.tools/faq |
| Agentic.market | **UNKNOWN** | Public information describes listing an API and validating an endpoint, but the account/identity requirements for editing an existing listing were not verified. Reference: https://agentic.market/about |

Do not interpret the A2A Registry's account-free initial submission as permission to manage a claimed listing without an account. Do not infer a no-account editing capability from Agent402's end-user tool-access FAQ.

## Proposed notice for legacy listing atlas_ai_data_qa_v1

**Option A — pause the old listing**

> **Status: Paused — superseded by ATLAS Clean v1.** Please do not submit new data or payments through atlas_ai_data_qa_v1. The current service information is maintained at https://atlas-clean-v1.hosamhosaam5.workers.dev. This legacy listing is retained for historical reference only.

**Option B — replace the old listing description**

> **ATLAS Clean v1 — CSV/JSON cleaning for agents.** Free preview of up to 10 cleaned rows. Inputs up to 100 KiB and 200 rows. Paid cleaning: 0.01 USDC per call on Base (USDC), using x402. Service: https://atlas-clean-v1.hosamhosaam5.workers.dev. Receiving wallet: 0x59Ea688b36464133E71873d8BeE8Fcb3BC369383.

These are proposed copy only. The existing atlas_ai_data_qa_v1 listing has not been edited, paused, deleted, or otherwise contacted.

## Change and verification boundary

- This document is intended for review before any external directory update.
- No external account creation, identity submission, listing update, offer, or customer communication was performed.
- The production trigger was disarmed separately in [PR #259](https://github.com/hosamhosaam5-ops/atlas-worker/pull/259). The post-merge GET /health could not be verified from the execution environment because DNS resolution failed twice; current post-disarm reachability remains **UNKNOWN** from this environment.
