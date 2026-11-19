---
bornAs: xr5w2xb
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# #6051 overlay-main-sync is useless for freeze tops

HIGH priority hint. - [HIGH, dispatched 14:46 ET] #6051 overlay-main-sync is useless for freeze tops. The kick job uses stdio:ignore (failures lose their logs); the conflict wake fires only when old.pr is set (freeze tops have pr:null); no retry until main moves; the needs-you alert has no consumer. First real case: fix m4 at 12:45 ET, "command failed or incomplete". Worker purpose unblock-main-sync-gaps. - Note: origin/lane/unblock-lane-acquire-contention was re-pushed at 7e4128da5b after #6055 merged (stale branch). Delete it once confirmed unused.

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
