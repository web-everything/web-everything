---
bornAs: xuspar8
kind: story
size: 5
status: open
scope: ["we:scripts/operations/run.mjs", "we:scripts/operations/prototype-load.mjs", "we:scripts/verify-lane.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Operator tools run from the latest green+audited prototype, not from main

Held card 2026-11-01 17:12 ET. Workers in a lane on main ran the OLD slow loader while the #6182 fast-return existed only as a prototype on daemons, so loads blocked over 170 s again. Fix: we:scripts/operations/run.mjs resolves operator tools (prototype-load, verify, heavy-admission client) from the latest green+audited prototype when one exists (like the Forge clientPath override), else main.

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
