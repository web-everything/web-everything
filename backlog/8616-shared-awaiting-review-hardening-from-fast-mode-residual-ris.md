---
bornAs: xp7j1bb
kind: task
status: open
dateOpened: "2026-11-20"
tags: []
---

# Shared awaiting-review hardening from fast-mode residual risk

From the "Fast-mode residual risk" section of the #7243 PR body (R825, shared awaiting-review hardening). Four reinforce-later items:

1. An orphan advisory label routes to the reviewer instead of being ignored.
2. Fixer-process suppression: a running fixer process must not be suppressed or masked.
3. A PR that is not certified must never be treated as such without a ready label.
4. A push-based clock for awaiting-review timing, not a wall-clock or timestamp one.

## Acceptance

- [A1] **Executable** — the awaiting-review tests (run through `node we:scripts/readiness/heavy-admission.mjs run -- node --test` on the existing awaiting-review test files) gain four cases that fail on main: orphan advisory label reaches the reviewer; fixer-process suppression is refused; not-certified without a ready label is not certified; the clock advances on push, not time.

## Non-goals

- [N1] Does not change review verdict semantics or add new labels.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Labels are matched exactly, never by substring.
2. **Truncated reads** — Unreadable label or process state refuses (stays awaiting review).
3. **Shared state files** — Re-read labels after any write.
4. **Fail closed** — Missing ready label means not certified.
5. **Identity scoping** — Bind clock and label to the exact head.
6. **State over time** — The push-based clock resets on a new head.
7. **Who wrote it** — Advisory labels are trusted only from the expected producer.
