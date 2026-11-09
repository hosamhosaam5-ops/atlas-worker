# ATLAS Clean v1 isolated Worker

## Scope

`atlas-clean-v1` is an independent Cloudflare Worker. It does not import or route through `src/index.ts`, does not bind D1, and does not require an application secret. The production-prepared file is `wrangler.clean-v1.toml`; it is not deployed by this change. The isolated test configuration is `wrangler.clean-v1-trial.toml`, with the separate Worker name `atlas-clean-v1-trial`.

## Current endpoints

- `POST /x402/clean_v1/preview`: accepts raw CSV (`text/csv`) or JSON array (`application/json`) and returns a cleaned preview of up to 10 rows.
- `GET /x402/clean_v1/preview?format=csv&data=...` (or `format=json`): query-based preview for small inputs. GET is limited to an 8,000-character URL by design; use POST for the full 100 KiB allowance.
- `POST /x402/clean_v1`: intentionally returns `503 PAYMENT_ROUTE_NOT_READY` in this PR. Payment and settlement are implemented only in the next PR; this endpoint must not return a cleaned paid result yet.
- `GET /health`: returns a minimal service identity and status.

## Bounds and response behavior

The engine enforces a 100 KiB input ceiling and a maximum of 200 source rows, including malformed rows. The preview returns at most 10 cleaned rows, with row-level changes and malformed-row diagnostics. Dates are normalized only when the supplied day/month order is unambiguous; ambiguous dates remain unchanged with a diagnostic. Duplicate removals are represented explicitly in `changes`.

Responses set `Cache-Control: no-store`. The Worker does not call `console.*`, persist request bodies, persist outputs, or bind a database. Error responses expose only a stable `code` and HTTP status; thrown exception messages are not returned.

## Preview rate-limit status

A small in-memory per-isolate limiter allows 10 preview requests per client IP per rolling minute. It is deliberately not represented as a global quota: Workers run in multiple isolates/locations and this implementation does not coordinate them. Global rate-limit enforcement on Workers Free is therefore **UNKNOWN**. No rate-limiting binding, Durable Object, KV, Queue, or paid service was added for preview rate limiting.

## Payment readiness

The paid route remains fail-closed until the separate x402 payment PR. It must return a payment challenge only after the new payment path has tests proving the exact Base USDC contract, chain ID, payee wallet, facilitator verification/settlement ordering, and replay rejection. No live facilitator is assumed available.
