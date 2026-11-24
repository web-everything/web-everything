---
bornAs: x3v0vu3
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/__tests__/health-responder-core.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-21"
preparedAgainstSha: "3bc136a74ba6e8c87e4e35c69361c15ec4d54ad1"
tags: []
---

# Health responder: lane-release safety test fails when a precondition is removed

Follow-up from the #3490 advisory (2026-10-02). The lane safety test in we:scripts/conveyor/__tests__/health-responder-core.test.mjs:100 asserts only `hold`, so the later `adapter-unavailable` guard masks removal of release-lane predicates. Strengthen the tests to identify the refusing rule, while retaining a valid lane control that reaches the adapter guard.

## Design

Keep the implementation scope test-only: we:scripts/conveyor/__tests__/health-responder-core.test.mjs. Reuse its `input` helper and the existing `LANE1` case from we:scripts/conveyor/__tests__/fixtures/health-responder/replay.json; clone a fresh input for each case. No production or fixture-file change is needed.

Split the mixed lane/claim test into named lane cases and the existing claim regression. Use a parameterized lane matrix with the field and bad value in each test name. For each of `terminal`, `workerDead`, `clean`, `reachable`, and `reaperPermitted`, exercise false, null, and absent values; for `reserved`, exercise true, null, and absent values. These are the six strict checks in `predicate` in we:scripts/conveyor/health-responder-core.mjs:132. Every case must assert `decision: hold`, `rule: preconditions-unproved`, and `applied: false`.

Test `changedIdentity: true` separately: it must return `owner-or-terminal-hold`, not `preconditions-unproved`, because the common identity guard runs first in we:scripts/conveyor/health-responder-core.mjs:188. Add an explicitly named, unchanged `LANE1` control asserting `hold`, `adapter-unavailable`, and `applied: false`. This proves the negative cases are otherwise eligible to reach the adapter boundary. Preserve the claim cases and their specific `preconditions-unproved` expectations.

## MVP

1. Replace the lane loop's outcome-only assertion with independently named cases covering all six predicate fields and missing/unknown evidence.
2. Separate the replacement-identity case and pin its earlier refusal rule.
3. Add the valid-lane control and retain all existing claim coverage.
4. Collect mutation evidence using temporary copies or in-memory modules; ship only the test change. Do not enable an adapter or alter lane-release policy.

## Test plan

The matching test file and sole implementation scope entry is we:scripts/conveyor/__tests__/health-responder-core.test.mjs. Run that file with Vitest from the WE repository root (pass its repository-relative path to `npx vitest run`). Every matrix row must pass on the current production implementation. Retain the closed decision-table replay suite, including `LANE1`, and verify the claim cases still pass.

For each of the six release-lane conjuncts in we:scripts/conveyor/health-responder-core.mjs:132, remove only that conjunct in a disposable copy and rerun the matching named lane tests. Each mutant must fail on the corresponding unsafe-value rule assertion: it now returns `adapter-unavailable`. Also bypass the entire release-lane predicate: all predicate-negative cases must fail while the valid control still passes. Never leave a mutated production file in the delivered diff.

## Proof plan

Capture the unmodified targeted suite's passing result, then record each mutation, the named test that fails, and expected/actual rule. Restore the original source between mutations and rerun the targeted suite after the last one. The discriminating before/after evidence is that the old `hold` assertion survives the same mutation while the new `preconditions-unproved` assertion fails; an ordinary green test run alone does not demonstrate this regression fix. Review the final diff to confirm only we:scripts/conveyor/__tests__/health-responder-core.test.mjs changed during implementation. Run `npm run check:standards` as the delivery gate.

## Done when

- Must refuse false, unknown, or absent release-lane safety evidence with `preconditions-unproved`, and changed identity with `owner-or-terminal-hold`; tests assert the rule and no applied action.
- Must retain a valid lane control that reaches `adapter-unavailable` without releasing a lane.
- Must retain claim regression coverage and fail a named lane test for removal of each of the six release-lane predicate checks.
- Targeted Vitest tests and the standards gate pass with the original production source restored.

## Mutation mechanism (review clarification)

Mutants never touch the production file: write a mutated copy of the core plus a copy of the test (importing the copy) under a temporary directory inside the lane, or use an in-memory module as the preparation probe did, and run vitest on that copy only. Absent values are produced with `delete`, not `= undefined`. The matrix is 18 cases (5 fields x 3 plus `reserved` x 3). The old test line near we:scripts/conveyor/__tests__/health-responder-core.test.mjs:188 (cited as :100 in the intro) is the one replaced.

## Edge cases this change must handle

1. Untrusted text — n/a: tests feed fixed in-memory fixture values; no card/PR/CLI text reaches a shell, argv, path or regex.
2. Truncated reads — n/a: no `gh`/`git` read; the suite reads only the local fixture we:scripts/conveyor/__tests__/fixtures/health-responder/replay.json.
3. Shared state files — n/a: tests clone a fresh `input` per case and never write shared files.
4. Fail closed — handled: every false, null and absent value for each of the six conjuncts must yield `hold`/`preconditions-unproved` (never `adapter-unavailable`), asserting `applied: false`.
5. Identity scoping — handled: `changedIdentity: true` is pinned to the earlier `owner-or-terminal-hold` rule (we:scripts/conveyor/health-responder-core.mjs:188), separate from the predicate cases.
6. State over time — n/a: `now` and budgets come from the fixture; no TTL, restart or repeat-suppression behaviour is exercised by these cases.
7. Who wrote it — n/a: no comment, ref, label or job name grants trust here.

## Acceptance

Each [A<n>] names a regression to add; run via `npx vitest run we:scripts/conveyor/__tests__/health-responder-core.test.mjs` (drop the `we:` prefix when executing) from the repo root, through we:scripts/readiness/heavy-admission.mjs `run --`. Each fails under the stated mutation and passes on the real source.

- [A1] Executable: we:scripts/conveyor/__tests__/health-responder-core.test.mjs named lane matrix — for `terminal`, `workerDead`, `clean`, `reachable`, `reaperPermitted` (false/null/absent) and `reserved` (true/null/absent), assert `hold` + `preconditions-unproved` + `applied: false`. Red before: with that one conjunct removed from `predicate` (we:scripts/conveyor/health-responder-core.mjs:132) in a disposable copy, the case returns `adapter-unavailable` and fails; today's `hold`-only assertion still passes.
- [A2] Executable: same file, whole `release-lane` predicate bypassed (`true`) in a disposable copy — every predicate-negative case fails and the valid control still passes. Red before: the old outcome-only loop passes under the bypass.
- [A3] Executable: same file, `changedIdentity: true` case asserts `owner-or-terminal-hold` (the common identity guard at we:scripts/conveyor/health-responder-core.mjs:188 runs before the predicate). The case sets `changedIdentity: true` TOGETHER with an invalid predicate field (e.g. `workerDead: false`) so guard precedence is observable; a second plain `changedIdentity: true` case on otherwise-valid LANE1 facts is kept. Red before: a mutant moving the guard after the predicate returns `preconditions-unproved` for the combined case, so the `owner-or-terminal-hold` assertion fails.
- [A4] Executable: same file, unchanged `LANE1` control asserts `hold` + `adapter-unavailable` + `applied: false` (fail-closed: the adapter boundary at we:scripts/conveyor/health-responder-core.mjs:218 still refuses release). Control, not a regression fix: it passes today and goes red only under a mutant that lets release through the adapter guard (it would then return the act-would-have outcome).
- [A5] Executable: same file, existing `CLAIM1` cases keep asserting `preconditions-unproved` for each delta. Compatibility check; must stay green after the matrix replaces the mixed loop.

## Follow-ups

No prerequisite or unresolved policy fork remains. Implementing evidence adapters, changing release eligibility, and auditing other action families' outcome-only assertions are separate work; this item establishes mutation-sensitive lane safety coverage only.

## Progress

- Original premise/scope: we:scripts/conveyor/__tests__/health-responder-core.test.mjs:100 could pass with all release-lane preconditions removed; the suggested cases were dirty, reserved, live worker, and unreachable, with a valid control. Scope named only the test file.
- Corrected premise/scope: the cited file and test still exist. The six release-lane checks also include terminal status and reaper permission; cover all six plus missing/unknown evidence. Replacement identity is an earlier common guard, so its expected rule differs. Implementation scope remains the existing test file, which is itself the matching test path; production and replay fixture paths above are read-only evidence.
- Source evidence: we:scripts/conveyor/health-responder-core.mjs:132 defines the six conjuncts; we:scripts/conveyor/health-responder-core.mjs:188 rejects changed identity; we:scripts/conveyor/health-responder-core.mjs:215 rejects unproved predicates before the adapter guard at we:scripts/conveyor/health-responder-core.mjs:218. The valid lane replay is at we:scripts/conveyor/__tests__/fixtures/health-responder/replay.json:1927.
- Preparation probe: imported the real decision function and an in-memory copy replacing the entire release-lane predicate with `true`. The valid control returned `adapter-unavailable` in both. Each current lane predicate-negative case, plus terminal false and reaper permission false, changed from `preconditions-unproved` to `adapter-unavailable`; every old `hold` assertion still passed. Changed identity remained `owner-or-terminal-hold`. This confirms the gap is not already delivered. No production file was mutated and no implementation tests were added during preparation.
- Re-prepare 2026-11-21: source moved since the last stamp; refreshed citations (conjuncts :132, identity guard :188, preconditions refusal :215, adapter guard :218; existing lane test now near we:scripts/conveyor/__tests__/health-responder-core.test.mjs:188). Goal unchanged and still undelivered (test asserts only `hold`). Added Edge cases and executable Acceptance [A1]-[A5].
