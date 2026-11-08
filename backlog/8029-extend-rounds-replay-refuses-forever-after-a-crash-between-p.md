---
bornAs: x0es2b2
kind: story
size: 3
status: open
scope: ["we:scripts/operations/effect-executor.mjs", "we:scripts/conveyor/round-extension-mark.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# extend-rounds replay refuses forever after a crash between post and applied-mark

Flow-sim gap C-G12, class K3 (one-shot step, no re-driver). Failing input: extend-rounds effect (idempotent:false, we:extend-rounds.mjs:60) dispatched; comment posted (we:extend-rounds-io.mjs:63) but the process dies before the effect is recorded applied.' 'E17 process death Cited: we:scripts/operations/effect-executor.mjs:256-279, we:scripts/conveyor/round-extension-mark.mjs:76. Soak-break sketch: none

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
