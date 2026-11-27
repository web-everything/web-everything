---
kind: task
status: open
scope: ["handoff:daemon-clone-git-guard"]
dateOpened: "2026-11-27"
tags: []
---

# Standards: install the DAEMON-CLONE-GIT-GUARD hook (operator-owned settings)

Once the guard script, its test and the wiring doc (the handoff wiring doc for the daemon clone git guard) are built, the PreToolUse Bash hook entry goes in the operator's claude settings, which only the operator or Standards may edit. Needed: the exact hook entry from the wiring doc; the activation-complete check with canary proofs on the non-existent clone wev-guard-canary-nonexistent; owners for follow-ups DAEMON-CLONE-HEAD-WATCHDOG and DAEMON-CLONE-EDIT-GUARD-CHECK. Until installed the guard protects nothing: the 11-27 14:24 ET review-daemon clone-restore wedge can recur.

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
