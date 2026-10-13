---
bornAs: x55mese
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/mechanical-round-cap.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Takeover-chain test follow-ups (#4797/#4770) and mechanical rounds for drain rebases

Held finding 233 (2026-10-11, operator approved #4797/#4770 with these). (a) #4797 negative-authorization tests run with takeovers ENABLED so they exercise the ruling guards; (b) #4770: test launchAttempted on the borrowed (spawnBorrowed) and wrapped (launchWrapped) paths; (c) extend "a mechanical round never spends a review round" to drain-made rebases and recovery refreshes (live #4757 hit 6/5 mostly from base-move refreshes).

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
