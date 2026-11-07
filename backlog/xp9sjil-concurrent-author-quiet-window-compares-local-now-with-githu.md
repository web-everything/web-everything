---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# concurrent-author quiet window compares local now with GitHub createdAt

Flow-sim gap R4-G10, class K16 (mixed clock domains). Failing input: fixer paused for a concurrent author on head H (pause marker comment). host clock ahead of GitHub by minutes. Cited: we:scripts/conveyor/reconcile-core.mjs:367-368. Soak-break sketch: double-act. The fixer is released early while the author is still pushing (or held too long if behind). Window bounded by skew; low severity.

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
