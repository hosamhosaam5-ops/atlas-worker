# ATLAS Agent Contract Gate — Design Partner Test Protocol

**Status:** Internal research kit only. Not sent to any person or agent. No outreach is authorized by this document.  
**Date:** 2026-10-13  
**Prototype branch:** `proposal/agent-data-qa-mvp-2026-10`.

## Objective

Determine whether the proposed tool solves a recurring, painful agent/tool handoff problem that existing in-process validators do not already solve well. This is not a promotional demo and should not presuppose demand.

## Study design

- Target: 3–5 agent builders who personally maintain a workflow with at least two connected agent/tool steps.
- Duration: 15–20 minutes per participant.
- Data: synthetic inputs only. Never ask for confidential payloads, API keys, customer records, or production traces.
- Product status disclosure: show the tool as an isolated prototype; it is not an available service and has no price.
- Comparative baseline: ask the participant to show or describe their current validator (Ajv, Zod, Pydantic, framework-native structured output, or another tool). Do not portray the prototype as better before comparing outcomes.
- No recording or attribution without consent. Capture only anonymized observations with permission.

## Synthetic task

An agent passes the following JSON to the next tool. The receiving step expects `agent_id` and `status` as strings, and `score` as a number between 0 and 1.

Valid input:
```json
{"agent_id":"agent-demo","status":"ok","score":0.72}
```

Invalid input:
```json
{"agent_id":"agent-demo","status":"ok","score":"0.72","extra":"unexpected"}
```

Expected behavior:
- Valid payload: `PASS`, zero issues.
- Invalid payload: `FAIL`, stable issue IDs and paths such as `/score` for a type mismatch and `/extra` for an undeclared field (when the contract prohibits additional properties).
- No coercion from the string `"0.72"` to a number, no repair, no raw value echoed in issue details, no automated retry or downstream handoff.
- Clearly disclose that only the documented subset of schema keywords is supported; this is not a full JSON Schema implementation.

## Interview script

1. “Walk me through the last real instance where schema mismatch or invalid tool output broke your workflow. What happened?”
2. “How often has this happened recently? What was the measurable impact: retries, latency, tool calls, manual repair, or failed jobs?”
3. “Show what currently validates this boundary. What does it catch and what remains painful?”
4. “Try the synthetic good/bad payload. Does this report change what you would do next?”
5. “Would you use this if it were available? What existing tool would it replace or complement?”
6. “Would you evaluate a pilot if the implementation and privacy requirements were met? Would you pay for it, and what would determine that decision?”

Do not lead with the solution before collecting the participant's unaided description of the problem.

## Per-participant scorecard

Use one row per participant. Leave blank until a real conversation has occurred; never fill by inference.

| Field | Values / note |
|---|---|
| Participant ID | DP-01 through DP-05; no personal data in this file |
| Relevant agent/tool workflow? | Yes / No |
| Recent concrete incident? | Yes / No + anonymized short note |
| Recurrence (participant's own estimate) | Participant's own words |
| Impact stated | Retry count / time / cost / failed runs / other |
| Current validator | Ajv / Zod / Pydantic / framework-native / other |
| Existing tool already solves it? | Yes / Partly / No |
| Synthetic task completed without help? | Yes / No |
| Report actionable? | Yes / Partly / No |
| Would pilot? | Explicit yes / no / unsure |
| Would pay? | Explicit yes / no / unsure; no price suggested |
| Disconfirming evidence | Free-text factual note |
| Consent to anonymized note | Yes / No |

## Go / no-go criteria

Proceed to a narrowly scoped product integration only if all of the following are met:
- At least 3 of 5 participants independently report the relevant failure as recurring.
- At least 2 of 5 complete the synthetic task or explicitly agree to a pilot.
- At least 2 describe a concrete gap not already solved adequately by their chosen free/in-process validator.
- Privacy, supported schema subset, and where validation runs are accepted by the participants.
- Willingness to pay is assessed independently; no price or revenue is assumed from a “would use” response.

Stop or pivot if the participants mostly report that framework-native validation/Ajv/Zod/Pydantic already solves the need, if the failure is not recurring, or if no one will test it.

## Execution boundary

This document is a protocol, not evidence that interviews were conducted. No messages have been sent; no participants, demand, revenue, or pilot commitments are being claimed. External contact requires explicit founder approval of the proposed audience/channel and copy. All subsequent product decisions must be based on actual, recorded, consented evidence.
