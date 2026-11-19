---
bornAs: xi8klzr
kind: task
status: open
dateOpened: "2026-10-31"
tags: []
---

# #6042 review carve-outs: three test gaps in ci-heal-escalation-mark and check-state-predicate

2026-10-30 19:45 ET: test gaps: 7-char SHA minimum only tested for 1-3 char prefixes (ci-heal-escalation-mark.test line 370); no test of several merge-gate rows sharing one lazy freeze read (line 496); conflicting-flags test only covers tied-rank rows (check-state-predicate.test line 70).

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
