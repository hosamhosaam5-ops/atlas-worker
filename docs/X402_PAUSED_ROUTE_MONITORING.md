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

## Required telemetry

For each matching occurrence, capture timestamp, HTTP status, request method/path, structured error code (when available), Worker version ID, invocation ID, Cloudflare Ray ID, and the D1 product status observed at the same time. Do not record payment signatures, authorization payloads, email addresses, wallet values, uploaded files, or request bodies.

Correlate repeated occurrences by error code, Worker version, and Ray/trace ID. Do not infer the internal error code from the HTTP status alone. Cloudflare's issue grouping title `HttpServerError · HTTP 503` is too broad to distinguish the cases above.

## Safe validation

The local integration test changes only the isolated Wrangler/D1 fixture: it asserts that PAUSED returns `503/X402_PRODUCT_NOT_READY`, then changes the local fixture to ACTIVE and asserts that GET returns `402` with x402 v2 requirements. The test must not call the production Worker, real facilitator, chain RPC, or settle payment. It restores the local fixture to PAUSED.

## Operational guardrail

Do not change production product status, wallet bindings, Cron schedules, or deployment as part of this monitoring classification work. Product activation and any real payment test require separate explicit approval.
