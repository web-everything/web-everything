---
bornAs: xio9qp2
kind: story
size: 5
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention: require test and authority contracts in decision handoffs

PR #5511 advisory review (2026-10-17) found unnamed refusal tests, unfinished epic acceptance, unspecified operator identity, mutable-debt bypasses and PR-derived standing lessons. Add a focused decision-handoff check for these contracts; reuse the general edge-case trace work in #5590 and structural headings work in #5739 rather than duplicating them. This card tracks prevention tooling; the stringency implementation obligations remain in epic 6236.

## Design

Extend the existing backlog rendering/acceptance check in `we:scripts/check-standards-rules.mjs`, with fixtures
in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`. The existing unfinished-acceptance check
currently requires an open prepared card, so an unprepared epic and its children can retain placeholders.
Apply completeness checks to epics with children and cards with a parent or dependency edges at the buildable
transition as well. Reject unnamed executable refusal/never/cannot guarantees and split separately testable
claims into named acceptance lines. Use explicit contract fields/sections for authority source, model input
fields and mutable guarded operations; do not claim arbitrary prose can be proved secure by keyword lint.

The prepare/review checklist must map every inherited invariant and decision edge case to an acceptance id,
including a non-monotonic settings fixture. A resolved design decision must identify the open epic/slice
owners of executable behavior and live proof. General edge-case-to-acceptance mapping is already owed by
[#5590](/backlog/5590-prevention-add-a-check-standards-rule-for-backlog-cards-ever/), and Risks/Test plan headings
by [#5739](/backlog/5739-prevention-add-a-card-lint-rule-that-every-edge-cases-this-c/); integrate those guards
when available rather than introducing parallel parsers. Their current placeholders are existing work, not
evidence of completed prevention.

## Owed prevention coverage from PR #5511

- Monotonic inheritance and inherited prose claims: slice 2 A6 now specifies `monotonic-levels`; require an acceptance trace for each inherited invariant during decision handoff.
- Unfinished epic/child acceptance, unnamed refusal tests and compound guarantees: A1–A2 below track deterministic card checks.
- Decision acceptance pointed at undelivered code: A3 requires the implementation owner rather than a false completion claim.
- Operator-only identity and debt mutation bypasses: A4 requires authenticated identity plus every mutable field/operation to be declared. The actual protected production write gate and independently verified payment are owed by slice 2 A10 and slice 3 A6–A7, including deletion, rename, kind, status, class, severity, confidence, deadline, due-level, source and forged-receipt cases.
- Missing/malformed model fields and stored lesson injection: A5 requires field/error cases and an explicit template-only instruction boundary. Runtime fixtures are slice 2 A8–A9 and slice 5 A5.
- Edge-case test mapping, Risks/Test plan and statute parity: reuse #5590/#5739; A3 requires ratified-rule parity during the handoff inspection. No implementation is claimed delivered by filing this card.
- Concrete table/enum domains, read-side guarantee traces, precedence pairs and repeated clocks: A6–A9 capture the latest advisory's correctness prevention requests; runtime owners are slice 2 A2/A13–A14 and slice 3 A2–A3.
- Trust-root self-protection and endpoint hints: A10–A11 capture the outstanding security prevention requests. Runtime owners are slice 2 A15–A16, slice 3 A11, slice 4 A6 and slice 5 A8. A5/A6 include the missing-quadrant fixture.
- Risk-to-test destinations: A12 captures the repeated security, simplicity and correctness requests, integrating #5739 rather than creating another lint owner.
- Latest advisory (2026-10-18): A6 now requires independent literal assertions for every ratified initial setting, A7 requires an injected-text fixture for each data-only/no-authority claim and a complete result matrix for pending guarantees, and A3 requires a knowable source for each model field plus reachable non-block fixtures. Runtime owners are slice 2 A5/A12/A17–A18 and slice 3 A12; these prevention obligations remain open.

## Done when

- [A1] **Executable** — test `handoff-unfinished-acceptance` runs the real card validator on epic-with-child, child-with-parent and dependency-bearing fixtures without preparedDate; the buildable transition refuses placeholder acceptance/non-goal/edge-case text while a completely authored counterpart passes.
- [A2] **Executable** — test `handoff-named-refusal-tests` rejects executable refusal/never/cannot lines without a backticked test id; independently named guarantee fixtures pass. Human review still checks that each line proves one guarantee, since a name alone cannot prove semantic coverage.
- [A3] **Inspection** — checklist `handoff-rule-and-owner-trace` requires each ratified invariant and edge case to cite its implementation acceptance owner, and resolved design decisions to point to the open epic/slices carrying executable and live proof. For each model-supplied field, state who can know its value, what evidence they have, and where it is consumed; move an unknowable field to the accountable decision owner rather than asking a reviewer to guess. Require production-path fixtures showing each intended non-block outcome remains reachable with honestly supplied fields. Review the PR #5511 fixtures for monotonicity, debt-only quadrant admission, expedite/debt/advisory reachability, low-confidence second check, overdue expedite, 45-day resurfacing and live recount; each has an owner rather than an assertion of delivered behavior.
- [A4] **Executable** — test `handoff-authority-contract` refuses operator-only or only-bypass fixtures lacking a named authenticated identity source and complete mutable-field/operation inventory. A self-declared actor, commit author or PR field does not satisfy the structured authority contract; complete protected-CI and payment-evidence declarations pass. This checks the contract's presence, not its runtime enforcement.
- [A5] **Executable** — test `handoff-model-input-contract` rejects model-consuming fixtures without missing/malformed cases per declared field and agent-facing instruction writers without a concrete template-only or quoted-data boundary plus named test. A mere claim of sanitization does not pass.
- [A6] **Executable** — test `handoff-concrete-values` rejects a ratified table, enum or initial setting value without independent literal-value assertions and valid domains for each consumed input field; include the PR #5511 security severity rows, confidence threshold and debt-only quadrant as fixtures. Include negative fixtures where default-only resolution is tested but the literal current level or lessons-enabled value is not asserted; positive fixtures pin internal-delivery and true, plus every other ratified initial setting. Every ratified invariant names its input fields and consumption conditions, with missing and malformed cases per consumed field (extend A5).
- [A7] **Executable** — test `handoff-guarantee-trace` rejects a structured must/always/every guarantee without an acceptance id or named test, including read-side cascade resolution and source logging. Each structured "is data" or "confers no authority" claim must name an injected-text fixture id in the same acceptance line; a test of missing source fields alone does not pass. Every "pending X" guarantee must declare and test each result of X, including confirmed, not-real, failure, unavailable, timeout and stale/malformed results; a pending-only test does not pass. Include rejecting fixtures for the PR #5511 gaps and passing complete counterparts. Checklist inspection catches prose guarantees omitted from the structured contract and verifies the result matrix; extend A2 beyond refusal wording.
- [A8] **Inspection** — checklist `handoff-precedence-pairs` enumerates every competing source pair, including two rules of the same kind, and requires a declared winner and fixture per pair.
- [A9] **Inspection** — checklist `handoff-clock-contract` requires each clock/threshold to declare its baseline and repeat behaviour, with N+1-item and second-threshold-crossing fixtures.
- [A10] **Executable** — test `handoff-trust-root-contract` extends A4 to refuse authority contracts that do not declare how the allowlist, gate workflow and credentials are protected from the PR under review, plus a named tamper test. Include PR edits to each protected component and PR-job credential access as negative fixtures.
- [A11] **Executable** — test `handoff-endpoint-bounds` integrates #5590's hint trace: when a write/receive-endpoint hint is present, require an acceptance line or explicit `n/a:` reason for each of body-size, rate limit and origin. Positive and negative fixtures cover omitted limits and read-only surfaces; field bounds and production ingress remain separately traceable.
- [A12] **Executable** — test `handoff-risk-test-locations` integrates #5739 with structured mappings from each Risk to a repository-qualified planned test path, named case and observable assertion, or explicitly identified inspection evidence. Reject name-only mappings; allow planned files clearly marked as not yet implemented.

## Non-goals

- [N1] No evaluator, debt writer, lesson job or authentication runtime in this card. No repository-wide migration or arbitrary natural-language theorem checker; lint enforces explicit structured contracts and the checklist covers semantic guarantees.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Markdown fixtures are data, never executed; quoted/instruction-bearing model field cases remain explicit in the contract (A5).
2. **Truncated reads** — a malformed/incomplete card cannot be declared buildable based on absent sections (A1).
3. **Shared state files** — n/a: pure card checks add no persistent state or writes.
4. **Fail closed** — incomplete structured contracts fail the transition; named tests alone do not establish runtime safety (A1, A4–A5).
5. **Identity scoping** — A4 distinguishes declaring an authenticated source from claiming a role; runtime verification belongs to the guarded writer.
6. **State over time** — preparedDate absence cannot exempt related buildable work (A1); existing resolved archives are not retroactively reopened.
7. **Who wrote it** — the same contract validation applies to operator and agent card authors (A4); card text grants no authority.

## Risks

Keyword-only lint can miss claims or misclassify quotes. Require explicit structured contracts, negative/positive
fixtures and checklist inspection rather than claiming semantic proof. Reuse existing card parsing and avoid
duplicating the pending #5590/#5739 checks. Runtime authority still needs production integration tests in the
stringency slices.

## Test plan

Planned file `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` owns the named executable
A1–A2, A4–A7 and A10–A12 cases with their rejection/pass assertions above. Include prose quotes, missing
sections, non-string fields and positive document-only handoffs. A3, A8 and A9 are explicitly inspection
evidence: attach the completed rule/owner, precedence-pair and clock checklists against PR #5511's decision
and all five slices before resolving this card. The check implementation remains owed; filing this card is
the prevention deliverable for this advisory repair, not evidence that a new lint already runs.
