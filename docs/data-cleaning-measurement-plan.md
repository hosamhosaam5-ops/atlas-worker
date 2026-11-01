# ATLAS Data-Cleaning Measurement Plan

Status: prepared; the formal measurement window has **not started**.

## 1. Pre-deployment qualification (local only)

Run the data-cleaning Worker through the repository-locked Wrangler CLI using wrangler dev --local. Do not use Python for this qualification.

### Input boundary

- Formats: CSV and JSON only.
- Maximum data rows: 10,000.
- Maximum upload size: 5 MiB.
- Synthetic fixtures only; no customer, production, or personal data.
- No D1 atlas_db binding, Cloudflare account access, remote binding, secret, deployment, public route, or external provider call.
- All local state is disposable and removed by the CI job.

### Corpus

Run 30 synthetic files: 25 valid CSV/JSON cases and 5 expected rejection cases (four malformed/invalid files plus one oversized file). Cover delimiters, quoted delimiters/newlines, BOM, blank rows, whitespace, exact duplicates, email/date/number normalization, null conversion, rename/extract paths, validation, format conversion, malformed quoting, row-width mismatch, invalid JSON, row-limit overflow, and file-size overflow.

For every valid file, compare delivered bytes with the deterministic engine's unchunked output. For every invalid file, require the exact stable error code and no result delivery. Never print input cells or output contents in logs.

### Chunking and retry gate

- Configurable chunk row limit; initial default: 250 rows.
- Queue message payload chunking remains bounded to 48 KiB.
- Record per-job job_id, input bytes/rows, processing chunk count, per-chunk input/output row counts, chunk_compute_ms, end-to-end elapsed time, Queue retry count, and deletion result.
- Inject one transient failure after the middle processing chunk has been durably committed. The retry must not duplicate the chunk or any output rows.
- Require byte-for-byte equality with the unchunked engine, 100% expected row accuracy, zero unrequested changes, one-time delivery, and removal of temporary job state after delivery.
- Performance target: P95 synchronous chunk-compute time below 7 ms; no chunk above 10 ms. chunk_compute_ms is measured around synchronous transformation with performance.now() in the local Worker. It is a local compute-duration proxy, not Cloudflare's billed CPU-time metric.

### Qualification decision

A failed fixture, unexpected mutation, duplicate/lost row, exposed cell value, retry duplication, non-deleted temporary state, or missed performance gate blocks qualification. Fix the root cause without weakening assertions. Stop after two documented attempts for the same root cause and report the evidence.

## 2. Controlled post-approval pilot

This stage is separate from local qualification and is not authorized by this plan alone.

- Duration: first 30 days after the owner explicitly authorizes publication and customer intake.
- Maximum: 10 paid tasks total during the pilot.
- Price range: USD 5–25 per task, with the approved quote for each task.
- No expansion, additional sources, new success criteria, spending, advertising, external outreach, customer acceptance, or financial commitments without the owner's explicit approval.
- Do not expand before 10 completed and documented tasks.
- Keep a per-task evidence record: input format/size/row count, expected and actual output checks, delivery result, elapsed time, support/rework, customer outcome, and any incident. Store no raw customer files in public logs or CI artifacts.

## 3. Start conditions and freeze

The formal 30-day pilot starts only after:
1. local qualification is green across the 30-file corpus and the 10,000-row chunk/retry test;
2. final PR review is complete and the owner approves the production release;
3. the owner separately authorizes publication, customer intake, external communication, and any payment collection.

During the formal measurement window, freeze deployments except for a purely technical incident fix. Do not change the cohort, measurement period, data sources, thresholds, or success criteria during the window without owner approval.

Current status: local technical qualification is being prepared; no production release, public launch, customer intake, paid task, or 30-day measurement window has started.


## 4. Authenticated Worker API and abuse controls

- Public upload endpoint: `POST /v1/jobs`.
- Status and result endpoints: `GET /v1/jobs/{job_id}/status` and `GET /v1/jobs/{job_id}/result`.
- Every public API request requires `Authorization: Bearer <CLEANING_API_TOKEN>`. The token must be at least 32 characters and is provisioned only as a Cloudflare Worker secret; never commit it or place it in Wrangler vars.
- Missing server-side token fails closed with HTTP 503; missing or incorrect client token returns HTTP 401. Authentication is checked before request-body processing or Queue submission.
- Upload rate limit: 10 accepted upload requests per rolling fixed 60-second window per SHA-256(token + client IP), enforced by a dedicated Durable Object. The limit is configurable from 1 to 60 per minute; production default is 10. Rate-limit storage does not retain the raw token or IP.
- Rate-limit enforcement fails closed with HTTP 503 if its Durable Object binding is unavailable.
- `TEST_MODE` is unset in the production `wrangler.toml`; test-only health, status, result, and fault-injection routes return HTTP 404 unless an isolated test configuration explicitly sets `TEST_MODE=1`. The local CI configuration uses a clearly non-production fixture token and a 2-request/minute limit only for its synthetic auth test.
- No secret value is committed. Production release requires separately provisioning `CLEANING_API_TOKEN` as a Worker secret; this PR does not provision it.

## 5. Final package input ceilings

The engine-wide hard ceiling remains 10,000 data rows and 5 MiB per file. Package-facing limits are:

| Package | Maximum data rows per file | Maximum upload size |
|---|---:|---:|
| Basic | 2,000 | 1 MiB |
| Standard | 5,000 | 3 MiB |
| Advanced | 10,000 | 5 MiB |

These are the approved package ceilings for documentation and offer design. The current Worker enforces the engine-wide ceiling (10,000 rows / 5 MiB); package-specific enforcement is not active until customer entitlements are mapped to separate credentials. Do not represent lower-tier caps as technically enforced before that mapping exists.
