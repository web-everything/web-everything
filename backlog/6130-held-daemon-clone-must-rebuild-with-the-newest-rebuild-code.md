---
bornAs: xdaglj4
kind: story
size: 3
status: open
dateOpened: "2026-10-14"
tags: []
---

# Held daemon clone must rebuild with the newest rebuild code, not its held last-good snapshot

Live 2026-10-14: the drain clone held on last-good 533464401 (smoke-env-timeout); its rebuild job runs we:scripts/lib/daemon-rebuild.mjs from the .snapshots/code/533464401 copy, so a fix to the rebuild machinery itself (PR #5293) can never arrive via the daemon's own tick, only via a manual daemon-load-overlay from a lane, which is refused while a job is in progress. Wanted: rebuild jobs run the rebuild module from the candidate (or an overlay touching daemon-rebuild) when it is newer, setting with source logged.

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
