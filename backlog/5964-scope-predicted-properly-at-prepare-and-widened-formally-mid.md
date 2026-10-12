---
bornAs: xswexdn
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/scope-bloat.mjs", "we:scripts/backlog-stranded-sweep.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Scope predicted properly at prepare, and widened formally mid-flight (scope-increase request)

Held finding 232 (2026-10-11; operator: formal way to ask for increased scope, should be in prepare). Live #4631: card xu7kxtt declared 3 files, the PR legitimately reached 11 (operator rulings), the scope-bloat hold fired only at round 8, and the card scope had to be widened by hand-PR (#4902). Fix: (a) prepare touch-set probe includes callers, tests and settings files of the named files and records a confidence; (b) a scope-increase request a fixer/builder files the moment a fix needs out-of-scope files (reason: operator ruling / reviewer finding / dependency), auto-approved when it cites an operator ruling or a mandatory finding on in-scope code, else surfaced to the operator queue; approval writes the widened scope onto the card in the same PR and the scope check reads it. Settings via the cascade.

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
