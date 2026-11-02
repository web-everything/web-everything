---
kind: story
size: 2
status: open
scope: ["we:pass-daemon.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Adopting a rebuild never restarts the pass daemons

HIGH priority hint. ## (held 2026-10-27 18:34 ET, HIGH) Adopting a rebuild never restarts the pass daemons The review clone pass daemons (advisory-label-sweep-we, ci-red-recovery-watch-we, load-flake-reverify; PIDs 1294/1312/1339) have run since Oct 22 08:07 ET on the code loaded then. Every overlay or main adopted into wev-review-daemon since then is NOT live for those passes (live case: #6020 adopted at 16:59 ET, 0 task-timing lines). we:pass-daemon.mjs:498-533 restartOntoNewCode is opt-in and never fired. Fix: the rebuild adoption path restarts every pass daemon whose entry file (or import graph) changed (exit-for-KeepAlive, or launchctl kickstart), and logs it. Prove it: adopt a change, and the pass PIDs and start times change and the new behaviour shows.

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
