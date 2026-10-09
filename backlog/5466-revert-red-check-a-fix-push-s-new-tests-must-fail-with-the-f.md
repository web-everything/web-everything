---
bornAs: x5d9nso
kind: story
size: 5
parent: "5467"
status: open
relatedTo: ["5468"]
blockedBy: ["5534"]
scope: ["we:scripts/operations/verify.mjs", "we:scripts/operations/mutation-check.mjs", "we:scripts/lib/verify-settings.mjs"]
dateOpened: "2026-10-08"
tags: [verify, fixer]
---

# Revert-red check: a fix push's new tests must fail with the fix reverted

Fixer/review proposal, operator 2026-10-08, P6 (B3). For a fix push, verify also runs the tests the fix added or changed against head with the fix's non-test hunks reverted; they must go red. Reuse the existing mutation-check tool (we:scripts/operations/mutation-check.mjs and its restore-in-finally IO shell we:scripts/operations/mutation-check-io.mjs), not a new mutate/restore path.

Targets ~12 weak-test findings (`gate-missed-catching-test` 10, plus PRs 4441 and 4481; ~140 fix min) in the 2026-10-08 window. Ruled: warn 3 days, then enforce; the mode is a setting. The "must go red" rule is a pure function in the protocol card 5468's shape. Runs inside verify, so it should land after A1 (push-on-green lane, not yet filed) makes verify-to-push fast; that card is 5534 (PR 4510), now in `blockedBy`.

## Acceptance

- [A1] **Executable** — a test with a fix whose new test passes with the fix reverted is flagged; a fix whose new test goes red is clean.
- [A2] The mode is a declared setting: off (today) / warn / enforce. Warn records the result and does not fail verify; enforce fails verify.
- [A3] Skipped (with a recorded reason) when the fix changed no test, or is not a fix push.
- [A4] The revert never touches the lane's working tree: it runs through mutation-check's mutate → run → restore transaction.
- [A5] Warn runs at least 3 days; the switch to enforce is a settings change citing the warn counts and false-red rate.
- [A6] **Proof** — on a live fix push, before/after: the verify record showing the revert-red result.
- [A7] The result is recorded where the fix session's record can be read back: the verify marker for the head (`revertRed`) and the `revert-red` log under the coordination root. Folding it into the completion record itself waits for the completion record v2 envelope (PRs 4436/4439), which owns that file.

## Non-goals

- [N1] No change to non-fix verify runs.
- [N2] No `Variants considered:` brief block in this card (proposal B3 mentions it; brief text is a separate change).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads diffs and test results, not free text.
2. **Truncated reads** — a test run that fails to load or collects nothing counts as "not proven red" (warn/fail), never as red.
3. **Shared state files** — the reverted tree is a temporary copy restored in `finally`; the lane is never left mutated.
4. **Fail closed** — in enforce mode, an error in the check fails verify; in warn mode it is recorded.
5. **Identity scoping** — the result is bound to the verified head sha.
6. **State over time** — the 3-day warn window is a setting with a recorded start date.
7. **Who wrote it** — "fix push" is decided from the fix role's completion record, not from the commit message.
