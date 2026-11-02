---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Live overlay tops that conflict with main are never refreshed automatically

MED priority hint. - (2026-11-01 10:44 ET) Live overlay tops that conflict with main are never refreshed automatically. overlay-main-sync-failed fires repeatedly (review/health-watch tops -1101a); #6159 auto-retire correctly skips them (unmerged content). Fix: on N consecutive sync failures for a live top, the daemon (or loader) builds a refreshed top on current main in a lane, runs the combined test, and swaps it via prototype-load --replace; conflicts it cannot resolve → one needs-you with the file list. FILED → appended to 7541 (PR #6192, 2026-11-01)

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
