---
bornAs: xsim499
kind: story
size: 1
status: open
scope: ["we:scripts/operations/record-referral-ruling.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Automatic referral-ruling policy never overrides an operator ruling

Held finding 230 (2026-10-11, safety). Live #4715 fixer stand-down 03:05Z: "auto-block also re-blocked an operator not-real (#4)". Fix: the auto-policy (actor auto-policy, may only rule block) skips any finding (same key or carried equivalent) that already has an operator ruling on this or an identical-diff earlier head; log the skip; test the #4715 case.

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
