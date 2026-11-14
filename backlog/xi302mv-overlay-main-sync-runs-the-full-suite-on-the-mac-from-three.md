---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# overlay-main-sync runs the FULL suite on the Mac from three daemons at once

HIGH priority load cut. overlay-main-sync in the pass-readers, drain and health-watch daemons runs heavy-admission run (FULL suite) in a temp clone (we-overlay-main-sync-*/repo) with no ../frontierui sibling, so sibling-inventory-failed puts the full suite on the Mac, 3 daemons at once (pids 28954, 48886, 48992 at 01:03 ET 2026-11-14). The caller is we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs. Fix: (a) run only tests related to the overlay diff (R913), and/or (b) give the temp clone a sibling or skip the sibling inventory so it goes to Forge; (c) one main-sync suite per main sha shared across daemons. Related card 8218.

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
