---
bornAs: x7mimqj
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# A parked worker's lane was reset with its unpushed commits on it

MED priority hint. ## (held 2026-10-26 01:06 ET) A parked worker's lane was reset with its unpushed commits on it 5481: lane-8 was kept leased on purpose to hold unpushed commits (2026-10-25 15:12 ET), but its lease disappeared and the branch was "Reset to origin/main" (reflog). The commits survived only because the worker cherry-picked them back from the reflog. Fix: a lane with unpushed commits is never reset or reclaimed; the reaper/salvage first pushes them to a lane/salvage-<lane>-<sha> branch, or refuses. A parked worker pushes a branch instead of holding a lease.

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
