---
bornAs: xya8ulp
kind: story
size: 5
status: open
scope: ["we:scripts/ci"]
dateOpened: "2026-11-02"
tags: []
---

# Revisit skipping push-to-main CI when the tree was queue-tested (superseded #6211)

Superseded PR #6211 (branch kept: its head 204b3154e4b03f0bdff2e25073a318b10e18d61c). Idea: skip the push-to-main CI run when the tree was already merge-queue-tested. Closed at round 9 (cap 6) under D-R378(3) and R88/R283 non-convergence: the red-team drew a new confirmed break class each round (tree-vs-SHA veto, rerun ordering, FUI default branch, timeouts), while every juror lens accepted. Value is low: the 2026-11-02 merge-queue measurement (the operator handoff measurement note item44) shows about 0 min wall-time saved, runner minutes only; only 12 of 70 merge commits have a same-SHA merge_group run, so the skippable share is unproven. If revived, it needs a design that proves equivalence by SHA/tree in one place, not a patched probe. Red-team breaks, verbatim: (1) we:scripts/ci/skip-queue-tested-push.mjs:153 A default-branch switch can invalidate the Frontier UI equivalence proof. Scenario: FUI main last push predates the queue run by a day; switch its default branch to release, queue-test WE against release, switch back to main without pushing; the adapter accepts the current main tip and old timestamp, the probe returns skip:true, so main CI skips tests against a sibling revision the queue never tested. (2) we:scripts/ci/skip-queue-tested-push.mjs:100 An older successful tree overrides a newer failure on the pushed SHA. Scenario: a successful merge-group run for SHA A at 12:00 and a failed run for SHA B at 12:10, both tree T and unchanged external inputs; push B directly to main; the probe returns skip:true using A because newerNonSuccess compares failures only against A's SHA. (3, result becd4d310afba907, head 204b3154) we:scripts/ci/skip-queue-tested-push.mjs:131 Equal start timestamps let a failed same-tree run bypass the failure veto. Scenario: two merge_group runs with identical trees and run_started_at 2026-10-31T12:00:00Z; run 100 succeeds at 12:10, later-created run 101 fails at 12:11; failedAt <= attemptTime(run) discards the failure before comparing trees, so decideQueueTestedSkip returns skip:true. Also open advisory (codex-correctness/COVERAGE, we:scripts/ci/__tests__/ci-run-less-workflow.test.mjs:132): no test asserts a scheduled run admits every full-suite job (nightly backstop). Stacked PR #6220 (base lane/ci-run-less-step1) needs re-basing onto main.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
