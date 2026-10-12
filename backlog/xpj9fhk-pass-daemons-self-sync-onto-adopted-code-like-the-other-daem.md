---
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/pass-daemon.mjs", "we:scripts/conveyor/health-watch-core.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Pass daemons self-sync onto adopted code like the other daemons

Held finding 215 (2026-10-10). Live: 10 pass daemons started 2026-10-09 21:09 ET ran pre-86da0b452 code for 20 h and wrote to GitHub as the operator instead of the App, because self-sync is off for pass daemons. Fix: WE_PASS_DAEMON_SELF_SYNC defaults on through the policy cascade (restart between passes onto adopted code, same as the main daemons), plus a health smell for any daemon process older than its clone adopted HEAD.

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
