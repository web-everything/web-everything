---
bornAs: xdqm1k2
kind: story
size: 2
status: open
scope: ["we:scripts/lib/red-main-quarantine.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Justify or trim quarantine as a second containment policy before it becomes default

From #4624 round-3 advisory (simplicity): we:scripts/lib/red-main-quarantine.mjs adds a second containment policy whose consumers are deferred. Before the quarantine-default flip, wire its consumers (ci skip step, auto add/prune, rerun routing) or trim it; red-team review required (operator gate). Blocks making quarantine the default.

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
