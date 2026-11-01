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
