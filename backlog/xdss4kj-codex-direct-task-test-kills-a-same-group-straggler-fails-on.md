---
kind: story
size: 1
status: open
scope: ["we:scripts/__tests__/codex-direct-task.test.mjs"]
dateOpened: "2026-10-31"
tags: []
---

# codex-direct-task.test 'kills a same-group straggler' fails on Forge

Live 2026-10-31 16:28 ET: we:scripts/__tests__/codex-direct-task.test.mjs 'kills a same-group straggler' fails on Forge with and without #6140, and passes on the Mac (worker a1218e29 run on lane-44, 320/321). Make it pass on Forge, or mark it env-dependent with a stated reason.

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
