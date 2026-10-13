# ATLAS Agent Contract Gate — MVP Decision & Prototype

**Date:** 2026-10-13  
**Status:** INTERNAL PROTOTYPE ONLY — not an approved product, not a public endpoint, not launched.  
**Production baseline:** `main` at `d02010c365809e8a8369a7c4bb9ea47c5c6f643c`.  
**Working branch:** `proposal/agent-data-qa-mvp-2026-10`.

## Executive decision

Prototype a small, deterministic **JSON contract gate between an agent/tool output and the next agent/tool input**. Do not expand the existing CSV/XLSX product yet and do not launch a generic data-quality or agent-evaluation platform.

This is the better *research hypothesis* of the two candidate workflows—not a proven commercial decision. Public evidence includes repeated framework-level reports about schema mismatch, invalid structured output, unclear validation errors, and handoff behavior. We have not yet validated buyer willingness to pay. Therefore only an isolated utility plus tests is authorized within this proposal; no runtime integration, route, public endpoint, database write, price, customer contact, or production deployment.

## Why this direction over a CSV schema add-on?

| Candidate | Evidence and fit | Current decision |
|---|---|---|
| CSV pre-handoff schema checks | Fits the existing `atlas_ai_data_qa_v1` base service and its current cleaning/QA path. The public scan performed here found weaker direct evidence for this exact CSV-to-agent workflow. | Retain as a possible extension; do not build it yet. |
| JSON contract checks at agent/tool boundaries | Multiple public reports describe JSON/schema validation and handoff problems in agent frameworks; it is a smaller independent unit that can be tested deterministically without an LLM or external dependency. | Chosen for an isolated prototype only. |

The public reports do not prove frequency, market size, commercial intent, or that a service is preferable to an in-process library. In particular, framework-native validation and libraries such as Ajv, Pydantic, Zod, and framework structured-output features are credible substitutes. The only plausible wedge to test is a small, framework-agnostic, no-network validation step with bounded, stable, privacy-conscious issue reports at the exact handoff point.

## Verified production baseline

- Existing catalogue item: `atlas_ai_data_qa_v1` — `ACTIVE`, base listed price 15 USDC per dataset.
- Existing scope remains CSV/XLSX cleaning and QA up to 5,000 rows. This prototype is **not** included in that price and must not be described as currently available.
- Read-only live D1 inspection showed product-linked orders in `MOCK` settlement mode and synthetic/safe-test quote notes. `demand_signals` was empty at the time of inspection. Those records are not proof of actual customers or revenue.
- Production health reports Worker and DB healthy and Telegram live; the running deployment remains unchanged by this branch.

## Public problem evidence (retrieved 2026-10-13)

These are public issue reports. They are examples of failure patterns, not a statistically representative market study and not confirmed buyer leads.

| Report | Relevant failure pattern |
|---|---|
| [LangChain #38719](https://github.com/langchain-ai/langchain/issues/38719) | Raw JSON-schema dict structured output reported as never validated, preventing a retry path. |
| [LangChain #40753](https://github.com/langchain-ai/langchain/issues/40753) | Unbounded retries reported after structured-output validation failures. |
| [LangChain #40471](https://github.com/langchain-ai/langchain/issues/40471) | Machine-readable details can be lost on an error path. |
| [LangChain #38223](https://github.com/langchain-ai/langchain/issues/38223) | A nested Pydantic schema can produce an invalid strict JSON Schema for a downstream API. |
| [LangChain #40423](https://github.com/langchain-ai/langchain/issues/40423) | A reported mixed tool/invalid structured-output path ends without the expected validation feedback loop. |
| [OpenAI Agents #3723](https://github.com/openai/openai-agents-python/issues/3723) | Handoff behavior reportedly does not enforce the strict schema as expected and can coerce types. |
| [OpenAI Agents #5169](https://github.com/openai/openai-agents-python/issues/5169) | A reported difference in constraint handling for omitted defaults versus explicit values. |
| [OpenAI Agents #4207](https://github.com/openai/openai-agents-python/issues/4207) | A report about model output appearing in validation errors despite a data-logging safeguard. |
| [LangGraph #8648](https://github.com/langchain-ai/langgraph/issues/8648) | Cross-field validation errors reportedly return empty messages. |
| [LangGraph #7986](https://github.com/langchain-ai/langgraph/issues/7986) | Request validation reportedly disagrees with accepted runtime values. |
| [LlamaIndex #21094](https://github.com/run-llama/llama_index/issues/21094) | A direct feature request for output-schema validation in FunctionTool. |
| [CrewAI #3074](https://github.com/crewAIInc/crewAI/issues/3074) | A reported Pydantic parser edge case with optional union types. |

Official framework documentation also describes native structured-output parsing and validation, which is evidence of competition as well as demand for correctness:
- [LangChain structured output](https://docs.langchain.com/oss/python/langchain/structured-output)
- [OpenAI Agents handoffs](https://github.com/openai/openai-agents-python/blob/main/docs/handoffs.md)
- [Ajv getting started](https://ajv.js.org/guide/getting-started)

## Prototype implemented on this branch

Files:
- `src/autonomy/contractGate.js`
- `test/agent-contract-gate.test.mjs`

The utility accepts serialized JSON plus a schema and produces a machine-readable `PASS`, `FAIL`, `INVALID_CONTRACT`, `INVALID_JSON`, or `REJECTED_INPUT` result. It does not call a model, network, database, or external service.

### Supported schema subset only

Supported keywords: `type`, `properties`, `required`, boolean `additionalProperties`, `items`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, and `uniqueItems`.

The implementation rejects unknown keywords, `$ref`, combinators, and unsupported schema dialects rather than silently ignoring them. This is **not a full JSON Schema implementation and does not claim conformance**. The caller must not treat its PASS as assurance for features outside the documented subset.

Safety/quality properties in the prototype:
- Input-size, schema-node, nesting-depth, and issue-count bounds.
- Stable issue codes and JSON Pointer paths.
- Raw payload values are not included in validation results.
- No coercion, auto-repair, retry loop, external dereferencing, or automatic handoff.
- No HTTP route, production pipeline wiring, dependency, or D1 schema change.

### Test status

A local isolated Node test run completed **14/14 prototype tests passing** on 2026-10-13. This covers valid payloads, missing fields, types, enum and numeric constraints, nested arrays/objects, pointer escaping, duplicate items, malformed JSON, size limits, schema fail-closed behavior, issue caps, non-finite-number rejection, payload depth/node bounds, and deterministic output. This is **not** the full repository test suite, CI verification, or production evidence. No CI result exists yet for this proposal branch.

## Demand validation gates before production integration

No outbound messages or marketplace actions have been taken or are authorized by this document. Before considering runtime integration:

1. Obtain founder-approved access to 3–5 agent builders/design partners; use synthetic data only.
2. Ask them to show the real boundary where a JSON contract mismatch causes retries, a failed tool call, rejected handoff, or manual repair.
3. Compare the prototype against what they already use (Ajv, Pydantic/Zod, or built-in framework validation); if their in-process validator already solves the same task at acceptable cost, stop.
4. Continue only if at least 3 of 5 independently identify the issue as recurring and at least 2 complete a synthetic prototype task or explicitly agree to a pilot.
5. Validate willingness to pay separately. Do not invent a price or assume the existing 15-USDC file-cleaning price applies.

## Required next engineering gate

After demand validation only: review the subset-vs-standard gap, add any necessary security/property-based tests, run the entire repository test suite in a safe CI context, and integrate behind an explicit opt-in with a default-off flag. The CI workflow `atlas-tests.yml` contains a registry-submission job as well as tests, so it must not be dispatched casually merely to obtain a test result. Avoid triggering that workflow unless its external side effects are positively disabled/guarded.

## Guardrails and rollback

- Do not merge this branch or deploy it automatically when tests pass.
- Do not change the active catalogue product, its price, checkout/payment path, wallets, or external communications.
- If design partners do not confirm this narrow problem, archive the prototype and retain the existing product unchanged.
