---
kind: story
size: 5
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention: require test and authority contracts in decision handoffs

PR #5511 advisory review (2026-10-17) found unnamed refusal tests, unfinished epic acceptance, unspecified operator identity, mutable-debt bypasses and PR-derived standing lessons. Add a focused decision-handoff check for these contracts; reuse the general edge-case trace work in #5590 and structural headings work in #5739 rather than duplicating them. This card tracks prevention tooling; the stringency implementation obligations remain in epic xrlwbd7.

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

## Done when

- [A1] **Executable** — test `handoff-unfinished-acceptance` runs the real card validator on epic-with-child, child-with-parent and dependency-bearing fixtures without preparedDate; the buildable transition refuses placeholder acceptance/non-goal/edge-case text while a completely authored counterpart passes.
- [A2] **Executable** — test `handoff-named-refusal-tests` rejects executable refusal/never/cannot lines without a backticked test id; independently named guarantee fixtures pass. Human review still checks that each line proves one guarantee, since a name alone cannot prove semantic coverage.
- [A3] **Inspection** — checklist `handoff-rule-and-owner-trace` requires each ratified invariant and edge case to cite its implementation acceptance owner, and resolved design decisions to point to the open epic/slices carrying executable and live proof. Review the PR #5511 fixtures for monotonicity, careless-debt block, low-confidence second check, overdue expedite, 45-day resurfacing and live recount; each has an owner rather than an assertion of delivered behavior.
- [A4] **Executable** — test `handoff-authority-contract` refuses operator-only or only-bypass fixtures lacking a named authenticated identity source and complete mutable-field/operation inventory. A self-declared actor, commit author or PR field does not satisfy the structured authority contract; complete protected-CI and payment-evidence declarations pass. This checks the contract's presence, not its runtime enforcement.
- [A5] **Executable** — test `handoff-model-input-contract` rejects model-consuming fixtures without missing/malformed cases per declared field and agent-facing instruction writers without a concrete template-only or quoted-data boundary plus named test. A mere claim of sanitization does not pass.

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

Add A1–A2 and A4–A5 fixtures to the existing content-lint test file and run it through the affected-test gate.
Include prose quotes, missing sections, non-string fields and positive document-only handoffs. Inspect A3
against the repaired decision and all five slice cards.
