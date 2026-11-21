---
kind: story
size: 2
status: active
scaffoldedBy: "fix-7224"
dateScaffolded: "2026-11-21"
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/main-red-recovery.mjs"]
dateOpened: "2026-11-21"
tags: []
related: ["7224"]
---

# reconcile-pass reads a reused main push as a broken merge base

After PR #7224, a reused main push concludes failure (main-execution reuse step) and skips test/smoke/daemon-soak. readMainCiRunConclusion (we:scripts/conveyor/reconcile-pass.mjs ~780-849) counts that failure as a finished red run and readCommitCheckRuns sees only skipped test, so isMainGreenFixOwed (we:scripts/conveyor/main-red-recovery.mjs ~454) treats reuse as main broken at base: a PR's own failure becomes an owed refresh instead of ci-heal. Exclude proven reuse with isReusedJobsPage (we:scripts/lib/main-ci-reuse-runs.mjs) and add a regression test.

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

## Duplicate admission

same defect class as PR #7224 send-back: reused-push evidence misread
