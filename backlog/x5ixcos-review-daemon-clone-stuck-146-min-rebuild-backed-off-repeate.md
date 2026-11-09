---
kind: task
status: open
dateOpened: "2026-11-09"
tags: []
---

# review-daemon clone stuck 146 min — rebuild backed off repeatedly for reader-priority (#4044) because a…

review-daemon clone stuck 146 min — rebuild backed off repeatedly for reader-priority (#4044) because a long-lived pass-daemon reader (ci-red-recovery-watch-we, pid 2460, up 2h12m on the review clone) was refused 4x and gained priority; meanwhile review-dispatch refuses (checkout 5 behind main). Fairness must bound the reader priority window or let a rebuild pre-empt after N backoffs; clone-stuck SMELL should page, not just log.

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
