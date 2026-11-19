---
kind: story
size: 3
status: open
priority: high
scope: ["we:scripts/operations/urgent-verify.mjs", "we:scripts/operations/urgent-verify-marker.mjs"]
dateOpened: "2026-11-19"
tags: []
---

# urgent-verify signing key readable by checkout subprocesses via HOME (receipt forgery)

Checkout subprocesses in we:scripts/operations/urgent-verify.mjs run as the signing user with HOME in their env, so a test or script in the verified checkout can read or preseed the predictable urgent signing key and forge a green receipt. Worktree isolation does not stop this. Fix: do not pass HOME or the key path to step children (give them a private HOME) and keep signing out of their reach. Found by the R1085 audit of lane/urgent-verify-fixes; pre-existing. Priority high (security).

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
