---
bornAs: x9eyphi
kind: task
status: active
scaffoldedBy: "fix-cap-raise"
dateScaffolded: "2026-11-20"
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# lane-pool #2924 containment probe fails inside agent shells despite a clean lane

Inside agent shells every acquire (auto-pick and --lane=7/8) is refused with 'no longer provably safe to reset (0 uncommitted, 0 ahead, provably-pushed=true)' while the same acquire works from the operator shell (lane-13 at 06:51 ET). A probe step must be erroring silently; check PATH and DEVELOPER_DIR in the agent env.

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
