---
bornAs: xl427eq
kind: task
status: open
dateOpened: "2026-10-14"
scope: ["we:skills-src/review/"]
tags: [prevention]
---

# Require collection closure proof when reviewing read caches

Add a review-lens rule requiring a cache of a collection to prove that no later members can appear. Every currently listed row being completed does not prove that the collection is closed.

Raised by the security review of web-everything/web-everything#5290. Check both the parent lifecycle and pagination or projection: a completed prefix, a missing later workflow, and a full page must not become final CI evidence. An immutability proof must precede the payload it vouches for.

## Done when

The review instructions explicitly ask for collection closure and proof-before-payload ordering, with a staged-workflow example in which a later member appears after an all-completed first response.

Require an inventory of every mutation that can reopen a cached parent, including both run-level and job-level reruns, with a regression through each public runner. Test failed writes and readers finishing after invalidation. Compare physical eviction scope with lookup validity scope: when a shared generation invalidates all collections, remove redundant per-parent eviction parsing.

Require host and credential isolation tests that hold the repository path, object id, and token constant while changing only the remote host. Review the actual child environment at each runner boundary, not only the configuration environment.

For performance claims, count every real spawn, including completion-proof reads, in repeated in-progress polling tests. Require either at most one real request per poll or a cheap pre-check that skips proof reads for known unfinished work. Audit every exposed cache policy key for an exercised behavior path; remove settings that have no effect. These prevention checks also capture the nonblocking polling-cost and inert check-runs-setting findings from the 2026-10-15 review.

The PR #5290 repair adds total-spawn assertions through both gh runners: five polls within the ten-minute proof retry window cost six requests, including the initial proof. Include failed proofs and completed but uncacheable responses (truncated collections or oversized payloads), and verify that the eventual fresh completion proof still precedes storage. Policy audits must cover platform settings and source reporting as well as environment overrides; removing an env reader alone leaves the shared cascade's unknown-key path exposed.
