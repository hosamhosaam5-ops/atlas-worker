# ATLAS Clean v1 isolated Worker

## Scope

`atlas-clean-v1` is an independent Cloudflare Worker. It does not import or route through `src/index.ts`, does not bind D1, and does not require an application secret. The production-prepared file is `wrangler.clean-v1.toml`; it is not deployed by this change. The isolated test configuration is `wrangler.clean-v1-trial.toml`, with the separate Worker name `atlas-clean-v1-trial`.

## Current endpoints

- `POST /x402/clean_v1/preview`: accepts raw CSV (`text/csv`) or JSON array (`application/json`) and returns a cleaned preview of up to 10 rows.
- `GET /x402/clean_v1/preview?format=csv&data=...` (or `format=json`): query-based preview for small inputs. GET is limited to an 8,000-character URL by design; use POST for the full 100 KiB allowance.
- `POST /x402/clean_v1`: requires an x402 v2 payment authorization and upfront settlement before returning cleaned rows. Without a valid payment authorization it returns HTTP 402; settlement or facilitator failures fail closed. See the paid-route section below.
- `GET /health`: returns a minimal service identity and status.

## Bounds and response behavior

The engine enforces a 100 KiB input ceiling and a maximum of 200 source rows, including malformed rows. The preview returns at most 10 cleaned rows, with row-level changes and malformed-row diagnostics. Dates are normalized only when the supplied day/month order is unambiguous; ambiguous dates remain unchanged with a diagnostic. Duplicate removals are represented explicitly in `changes`.

Responses set `Cache-Control: no-store`. The Worker does not call `console.*`, persist request bodies, persist outputs, or bind a database. Error responses expose only a stable `code` and HTTP status; thrown exception messages are not returned.

## Preview rate-limit status

A small in-memory per-isolate limiter allows 10 preview requests per client IP per rolling minute. It is deliberately not represented as a global quota: Workers run in multiple isolates/locations and this implementation does not coordinate them. Global rate-limit enforcement on Workers Free is therefore **UNKNOWN**. No rate-limiting binding, Durable Object, KV, Queue, or paid service was added for preview rate limiting.

## Payment verification status

The paid route and its mocked settlement tests are implemented. No genuine payment or live facilitator request has been made. Live Base support and live replay rejection by the configured facilitator remain **UNKNOWN**; this PR does not claim the facilitator is operationally ready.

## Measurement and operational unknowns

### Local CPU approximation

CI runs the cleaning engine on 200-row CSV and JSON inputs 50 times per format using Node.js \`process.cpuUsage()\`. It prints the median and maximum measured process CPU time in milliseconds for each format. This is a local Node.js approximation around the synchronous engine call only. It can include runtime and garbage-collection noise and is **not** a Cloudflare Workers CPU measurement, a billing measurement, or a production performance guarantee.

Cloudflare Analytics identifies \`cpuTimeP50\` and \`cpuTimeP99\` in microseconds in the GraphQL schema. The observed Cloudflare p50/p99 values for this trial remain **UNKNOWN** because Analytics returned no invocation rows. Do not convert the local Node benchmark into Cloudflare CPU usage or use it as proof of free-plan compliance.

### Live settlement and fees

Live x402 settlement behavior, live facilitator availability and response behavior, and live EIP-3009 replay rejection remain **UNKNOWN**. No live facilitator settlement or genuine payment has been performed.

Facilitator fees, network/gas charges, any processor deductions, and the net amount received are **UNKNOWN**. The configured x402 amount of 10,000 USDC base units (0.01 USDC) is the advertised request amount only; it is not evidence of actual charges, fees, or net proceeds.

### Global preview limits

The Worker code caps each preview response at 10 rows and implements a best-effort limit of 10 preview requests per client IP per rolling minute per isolate. A global or platform-wide preview quota/rate limit across isolates, locations, or deployments is **UNKNOWN**. The in-memory limiter is not a global enforcement mechanism.

## Paid route: x402 v2 upfront settlement

- `POST /x402/clean_v1` returns HTTP 402 with the base64-encoded `PAYMENT-REQUIRED` header when no acceptable `PAYMENT-SIGNATURE` is supplied.
- The advertised requirement is `exact` / EIP-3009 on Base mainnet (`eip155:8453`): 0.01 USDC = `10000` six-decimal base units, USDC contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, and payee `0x59Ea688b36464133E71873d8BeE8Fcb3BC369383`.
- The requirement explicitly selects `paymentFlow: upfront`. The Worker calls only the facilitator `POST /settle` endpoint; it does not call `/verify`. A cleaned result is returned only after a successful settlement response has a valid transaction hash, the expected Base network, and a payer matching the signed authorization.
- Input format, file-size, and row-count validation occur in memory before settlement so malformed/oversized inputs are rejected without a payment attempt. The prepared result is not returned before successful settlement.
- The facilitator receives only the x402 payment payload and the fixed payment requirements. It never receives CSV/JSON file bytes, cleaned rows, or change lists. Application code does not log request bodies, payment payloads, facilitator error bodies, or file content.
- Missing/invalid payment returns HTTP 402 with a stable code. A rejected settlement returns HTTP 402 `PAYMENT_SETTLEMENT_FAILED`; facilitator/network/configuration failures return HTTP 503 with a distinct stable code. An incomplete settlement confirmation fails closed.
- `FACILITATOR_URL` is a non-secret Wrangler variable; the default is `https://facilitator.openx402.ai`. Tests inject a fake facilitator into the Worker factory and do not contact a live payment service.
- EIP-3009 authorizations are one-time-use. The facilitator/on-chain nonce check is the authoritative replay control. CI proves the Worker rejects a repeated authorization when the injected facilitator reports the nonce consumed; live facilitator replay behaviour and live Base settlement support remain **UNKNOWN** until separately verified without a real payment.
- Preview rate limiting remains best-effort in-memory at 10 requests per client IP per rolling minute per isolate. Global enforcement remains **UNKNOWN**. No rate-limiting infrastructure was added.
