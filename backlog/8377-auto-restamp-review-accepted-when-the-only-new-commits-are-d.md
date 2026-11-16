---
bornAs: xc7crdu
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-15"
tags: []
---

# Auto-restamp review:accepted when the only new commits are drain JIT-number renames

2026-11-15 12:40 ET MED: the drain's own JIT-number commit at land (99a225a8 'drain: JIT-number xmkzaom to #8328') made #6879's review:accepted STALE, so merge-gate HOLD and ready-stuck for about 50 min; the review daemon dropped it from candidates. Accept-carry should auto-restamp when the only new commits are drain JIT-number renames (no content change). Restamped by hand 12:40 ET (emergency, logged).

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
