---
kind: task
status: active
scaffoldedBy: "fix-4631"
dateScaffolded: "2026-10-10"
scope: ["we:scripts/check-standards.mjs", "we:scripts/conveyor/accept-carry-sweep.mjs", "we:scripts/conveyor/review-hold-reconcile.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Standards check: every exported conveyor sweep has a test that drives it through its caller

Prevention owed by PR #4631 review round 5. we:scripts/conveyor/accept-carry-sweep.mjs shipped with tests that called its planner and shell directly, while the one call into it from we:scripts/conveyor/review-hold-reconcile.mjs#sweepReviewHoldLabels had no test, so deleting that call left every test green and the daemon silently stopped carrying an operator clearance. Add a standards check that every sweep exported from we:scripts/conveyor/ is imported by a test that also imports its production caller, or carries an explicit waiver. PR #4631 round 5 added the missing caller test for this one sweep; this card is the guard against the class.

## Acceptance

- [A1] **Executable** — `npm run check:standards` fails on a `sweep*` function exported from `scripts/conveyor/` that no test file imports together with a production module that calls it, and passes once such a test exists or the sweep carries a named waiver.

## Non-goals

- [N1] Does not judge whether the caller test asserts the right thing (a mutation check does that, in the PR that adds the sweep); it only requires that one drives the caller.

## Edge cases this change must handle

1. **Untrusted text** — n/a: the check reads repo sources only.
2. **Truncated reads** — n/a: whole-file source scan, no paging.
3. **Shared state files** — n/a: read-only, no state written.
4. **Fail closed** — a source file the check cannot parse is reported as a failure, never skipped silently.
5. **Identity scoping** — n/a: repo-wide.
6. **State over time** — a sweep added later is found by scanning the exports, not from a hand-kept list in the check.
7. **Who wrote it** — n/a: applies to agent and human authors alike.
