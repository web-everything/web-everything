---
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing.md", "we:scripts/ci/test-timings.json", "we:scripts/conveyor/claude-auth-health.mjs", "we:scripts/conveyor/fix-dispatch-claim.mjs", "we:scripts/conveyor/owed-fix-recovery.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/soak/breaks/owed-fix-no-live-fixer-recovery.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/readiness/file-locks.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Split PR lane/fix-owed-no-fixer-selfheal into focused changes

size-split-key:b9e32a5f1ba01e520820adb22d55227acda39d3cb2bdcc68a6930e40239d19c9. Plan follow-up splits for PR lane/fix-owed-no-fixer-selfheal. File groups: we:docs/agent: 13; we:scripts/ci: 1; we:scripts/conveyor: 359; we:scripts/operations: 7; we:scripts/readiness: 4

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
