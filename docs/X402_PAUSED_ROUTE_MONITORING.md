# x402 route monitoring: expected paused-product responses

## Production invariant

`atlas_ai_data_qa_v1` remains `PAUSED` until the founder explicitly approves activation. A request to `GET /x402/atlas_ai_data_qa_v1` while the product is paused currently returns HTTP 503 with `X402_PRODUCT_NOT_READY`. This is an expected offer-state response, not evidence by itself of a Cloudflare platform outage or a failed payment.

## Classification rules

| Observation | Classification | Response |
| --- | --- | --- |
| Route returns 503 and structured error `X402_PRODUCT_NOT_READY` while D1 product status is `PAUSED` | Expected paused-offer response | Do not page as an infrastructure incident solely for this reason; retain a count/metric for paused-route traffic |
| Route returns 503 and `X402_WALLET_NOT_CONFIGURED` | Configuration failure | Alert operator; never log wallet values |
| Route returns 503 and `X402_VERIFY_UNAVAILABLE` | Payment verification dependency failure | Alert and inspect the correlated trace; do not retry a settlement |
| Route returns 503 and `X402_SETTLEMENT_REVIEW_REQUIRED` | Settlement outcome ambiguous | High-priority manual reconciliation; keep nonce locked; do not retry or automatically settle |
| HTTP 503 with no correlated structured error or unknown error code | Unclassified server error | Preserve as an incident until trace/log evidence explains it |

## Read-only monitoring audit (2026-10-21)

Cloudflare Observability returned one active issue group titled `HttpServerError · HTTP 503` with 224 occurrences. The latest inspected occurrences targeted `/x402/atlas_ai_data_qa_v1` (GET and POST) on Worker version `e3dbcfd7-24b6-4f8b-8452-20f93df01576`. The group records HTTP status, method/path, trace and Ray IDs, but not the route's JSON `error` code. Therefore the existing 224 occurrences cannot all be retrospectively labelled expected solely from this grouping.

The production D1 read returned `status=PAUSED`, `price_usdc=15` for `atlas_ai_data_qa_v1`. This supports classifying matching requests as expected only when the contemporaneous product state and the structured event agree. Cloudflare Observability returned no configured issue automations; do not globally silence the generic 503 group or claim automatic notifications are configured.

The Worker now emits a redacted structured `console.warn` event named `atlas_x402_route_503` for route-level 503s. It includes `error_code`, method, path, Ray ID, and only safe classification fields. It never logs wallet values, payment signatures, authorization payloads, file contents, or request bodies.

## Required telemetry

Correlate `atlas_x402_route_503` records by `error_code`, Worker version, and Ray/trace ID. Keep unknown 503s as incidents. Do not infer an internal error code from HTTP status alone; retain an occurrence as unclassified unless its structured event and contemporaneous D1 state support a known classification.

## Safe validation

The local integration test changes only the isolated Wrangler/D1 fixture: it asserts that PAUSED GET and POST both return `503/X402_PRODUCT_NOT_READY` without invoking facilitator verification or settlement, then changes the local fixture to ACTIVE and asserts that GET returns `402` with x402 v2 requirements. The test must not call the production Worker, real facilitator, chain RPC, or settle payment. It restores the local fixture to PAUSED.

## Operational guardrail

Do not change production product status, wallet bindings, Cron schedules, or deployment as part of this monitoring classification work. Product activation and any real payment test require separate explicit approval.
