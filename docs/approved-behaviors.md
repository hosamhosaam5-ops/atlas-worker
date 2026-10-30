# Founder-approved behaviors

This file is the operational source of truth for ATLAS behaviors that must not be changed without explicit founder approval. Read it before preparing every pull request. Any pull request that changes, weakens, bypasses, or reinterprets a numbered behavior below must remain unmerged until the founder has reviewed the exact diff and explicitly approved it.

## 1. Source circuit breaker

1. A source circuit opens only after **3 consecutive transient failures** (HTTP 5xx or timeout). The first and second transient failures leave the circuit `CLOSED`.
2. The initial open cooldown is **15 minutes**. After a failed half-open probe, the cooldown doubles exponentially and is capped at **6 hours**. A successful probe closes the circuit and resets the failure count and cooldown to 15 minutes.
3. HTTP **429** is rate limiting, not a transient-failure increment: the circuit remains unavailable until the provider's valid `Retry-After` time (or the existing fallback cooldown when no usable header is supplied).
4. HTTP **401/403** is `AUTH_REQUIRED`; it does not increment the transient-failure count and must not be silently treated as a retryable server failure.
5. Circuit state is isolated per source. A failure or recovery for one source must not open, close, or reset another source.

## 2. Demand eligibility and freshness

1. The maximum age for an eligible request is **30 days**. Missing or unverifiable creation time is not eligible. The original provider creation timestamp is preserved; discovery time must not be substituted to make an old request appear fresh.
2. A demand item must be an **open, still-actionable request**. Closed, completed, cancelled, expired, fulfilled, archived, rejected, or paid requests are not eligible; an expired deadline is not eligible.
3. The original source URL must be retained and independently checked before qualification. A URL must be safe to fetch and return a successful 2xx response; when HEAD is unsupported (405/501), the existing bounded GET fallback is used. Missing, unsafe, unreachable, or non-2xx original links are not qualified.
4. The request must match ATLAS's approved data-QA / data-cleaning capability. Seller offers and provider advertisements are not buyer demand.
5. Reject requests requiring upfront payment, deposits, funding, purchase/escrow, paid registration, a wallet, or a transaction prerequisite. Reject service mismatches and high-risk requests. Do not relax these rules to increase lead volume.

## 3. Approved demand sources

The current demand-scan allowlist is exactly:

1. `agent_job_public_mcp` — AgentJob Task Square (MCP).
2. `opentask_public_tasks` — OpenTask Public Tasks.
3. `payanagent_open_requests` — PayanAgent Open Requests.
4. `agent_souk` — Agent Souk public listings. Its current endpoint is a seller-offer catalog and is diagnostic only; those listings must not be reclassified as buyer requests or counted as qualified demand without explicit founder approval.

Adding, removing, replacing, or changing the role of a demand source requires explicit founder approval before merge or deployment.

## 4. Success criterion

The approved demand-validation success criterion is **at least 3 eligible, independently verified customer requests from at least 2 distinct approved demand sources within a rolling 7-day observation window**. Do not lower the count, reduce the source diversity, widen the eligible-request definition, or change the observation period without explicit founder approval. No revenue may be claimed from a lead, prepared offer, or unconfirmed payment.

## 5. AgentJob 60-second gate

1. `claimAgentJobListPostsGate` is persistent and atomic. It allows at most one AgentJob `list_posts` poll per source every **60 seconds**.
2. A second attempt before 60 seconds must be rejected/deferred before MCP initialization or `list_posts`; an attempt at or after 60 seconds may proceed.
3. If D1 cannot persist/read the gate, it fails closed. Do not bypass the gate with a manual scan, alternate code path, or in-memory-only state.

## 6. Mandatory founder stop points

Stop before taking the action and obtain explicit founder approval for each of the following:

1. Any spending, purchase, paid subscription, paid API, domain, hosting upgrade, advertisement, or financial commitment.
2. Any external communication, offer delivery, application, negotiation, or customer/partner contact.
3. Adding or replacing a source, changing source semantics, or broadening discovery scope.
4. Changing scoring, qualification, rejection, counting, source-diversity, or success criteria.
5. Changing the 30-day freshness rule or original-source verification/open-request requirements.
6. Deleting records, destructive data changes, production migrations, or any restore operation (including Time Travel restore).
7. Changing secrets, credentials, access permissions, OAuth scopes, tokens, or security boundaries.
8. Claiming revenue, a paid order, or successful settlement without verifiable production evidence.

## 7. Pull-request approval rule

Any PR that changes any behavior in sections 1–6 must be held from merge until the founder has seen the exact diff, its operational/policy impact, test evidence, and deployment impact, and has explicitly approved that PR. Green CI, an expected outcome, prior broad delegation, or an earlier approval for a different change does not substitute for approval of the specific behavior change.

Read this file before every PR from this point forward. If a proposed PR touches one of these behaviors, identify the affected numbered section in its description and stop for founder review before merge.
