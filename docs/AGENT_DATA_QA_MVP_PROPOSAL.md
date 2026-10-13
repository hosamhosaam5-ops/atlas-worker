# ATLAS Agent Data QA Gate — MVP Proposal

**Date:** 2026-10-13  
**Status:** Internal proposal only — NOT approved for launch, NOT an active product feature.  
**Repository baseline:** `main` at `d02010c365809e8a8369a7c4bb9ea47c5c6f643c`.  
**Change boundary:** This proposal lives on `proposal/agent-data-qa-mvp-2026-10`; do not merge or deploy without founder review.

## Decision

Extend the existing `atlas_ai_data_qa_v1` file-cleaning service with an **optional, deterministic schema/contract check before handoff**. Do not launch a second generic data-quality platform or change the existing active offer.

The narrow job to test is: *“An agent has a CSV for a downstream tool; verify that the file conforms to the expected columns and basic types, then return a machine-readable PASS/FAIL report so bad data does not silently enter the next step.”*

This is a product hypothesis, not a proven customer need.

## Verified baseline

- Live catalogue row: `atlas_ai_data_qa_v1`, status `ACTIVE`, listed price `15 USDC`, unit `dataset`.
- Current description: CSV/XLSX file cleaning and QA, with a starter scope of one dataset up to 5,000 rows, whitespace/header normalization, empty-row removal, duplicate detection/removal, missing-value statistics, clean CSV output, and a QA report. Advanced schema/type inference and custom pipelines are explicitly outside the current scope.
- Live database inspection was read-only. Records associated with this product were in `MOCK` settlement mode. The associated quote notes were synthetic/safe-test notes, and `demand_signals` contained no rows at inspection time.
- Therefore these records prove neither real customers nor revenue. The new schema-check extension has **zero verified paying users** and its price is **not set**.

## Competitive scan and positioning

| Alternative | Established capability | Implication for ATLAS |
|---|---|---|
| [Soda Data Contracts](https://soda.io/product/data-contracts) | Data contracts and checks across datasets, collaboration, production enforcement; Soda also presents API/MCP/CLI access for AI/data workflows. | Do not compete as a broad data-quality platform. |
| [Great Expectations validation](https://docs.greatexpectations.io/docs/core/run_validations/) | Expectation suites/validation definitions and validation results for data workflows. | Generic data validation is already served by mature frameworks. |
| [Ajv JSON Schema validator](https://ajv.js.org/guide/getting-started) | Open-source, JavaScript JSON Schema/JTD validation. | Simple JSON validation alone is easy to replace with a free library; do not sell a thin wrapper as a moat. |
| [Empirical study of AI-agent developer challenges](https://arxiv.org/abs/2510.25423) | Research identifies runtime integration, orchestration, and evaluation reliability among recurring agent-development challenges. | This is indirect evidence that interface failures matter; it does **not** prove willingness to pay for this product. |

### Hypothesized wedge

A small, file-oriented **pre-handoff gate** integrated with ATLAS's existing cleaning workflow—not an observability suite, database monitor, general-purpose agent evaluator, or replacement for Soda/GX/Ajv.

The useful output must be easy for an agent to consume: a stable JSON report, deterministic issue codes, and explicit PASS/FAIL semantics. Differentiation remains unproven until users confirm the need.

## MVP scope (proposal)

### Input
- UTF-8 CSV, no more than 5,000 data rows for the first iteration.
- A caller-provided JSON contract listing expected column names and supported primitive types: `string`, `integer`, `number`, `boolean`, `date`.
- Per-column `required` and `allow_empty` flags; optional declared key columns for duplicate-key checks.
- No model call required. Use deterministic code to keep behavior repeatable and free-first.

### Output
- `validation_status`: `PASS` or `FAIL`.
- `summary`: row count, column count, error count, warning count.
- `issues[]`: stable `rule_id`, row number when relevant, column name when relevant, and safe human-readable explanation.
- A cleaned/normalized CSV only through the existing documented cleaning behavior and only when explicitly requested by that workflow; never silently coerce invalid values.
- Do not include raw cell contents in the default report. Do not log uploaded row data. Preserve existing original-file handling.

### Initial validation rules
1. Contract is syntactically valid and uses only supported rule names.
2. Required headers exist; duplicate/blank headers are reported.
3. Required values are present.
4. Declared primitive types are checked strictly; invalid values are reported, not guessed or silently rewritten.
5. Optional declared key columns are checked for duplicates.
6. Empty files, malformed rows, and row limits fail closed with stable errors.

### Explicitly out of scope
- Arbitrary SQL, scripts, external enrichment, anomaly detection, inferred business rules, cross-table joins, LLM-based decisions, PII analysis, database connections, scheduled monitoring, general JSON-response validation, and automatic downstream execution.
- New public unauthenticated endpoint, new dependency, new database table, any payment change, and any deployment.
- No claim of support for XLSX contracts in v1; reuse the existing XLSX/cleaning path only where its existing behavior is already supported and tested.

## Acceptance tests before implementation can be considered ready

- Valid CSV + valid contract returns PASS and zero errors.
- Missing required header returns FAIL with a stable rule code.
- Missing required cell and invalid integer/number/date each return the expected issue.
- Duplicate header, duplicate key, malformed row, empty file, invalid contract, unsupported rule, and >5,000-row fixture each fail safely.
- Unicode and Arabic headers are handled deterministically.
- Report does not expose raw input cell values.
- Original input remains preserved; validation does not mutate it.
- Same input and contract produce the same normalized report.
- No model/provider call is needed.
- Existing test suite and current live health remain unaffected; no changes to main/live without separate approval.

## Demand validation gates (before writing runtime code)

The public research so far supports only a problem area, not this exact offer. Before implementation:
1. Review 10 recent, public developer issues/discussions for a concrete CSV/schema handoff failure in agent/tool workflows; record links and avoid counting generic AI complaints.
2. Ask for founder-approved access to 3–5 agent builders/design partners. No unsolicited outreach is authorized by this document.
3. Show a synthetic input/contract/report only. No customer data needed.
4. Continue only if at least 3 of 5 target users independently report this as recurring and at least 2 complete the synthetic task or explicitly agree to a pilot.
5. Test willingness to pay separately. Do not assume the current $15 base price applies to the new feature.

## Guardrails and rollback

- This is documentation only. No production state, product status, price, payment path, key, runtime code, or customer message changes.
- Do not merge this proposal automatically just because CI passes.
- Keep the existing product and $15 base offer unchanged. If the new contract gate is not validated, stop and improve the existing product instead of creating another product.
