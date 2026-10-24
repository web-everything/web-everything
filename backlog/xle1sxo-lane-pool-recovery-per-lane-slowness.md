---
kind: story
size: 3
status: open
dateOpened: "2026-10-24"
tags: []
---

# Lane-pool recovery is slow: about 1.5-2 min per lane, so an 8-minute budget recovers only a few lanes

Recovery (PR 5855) runs a reclaim dry-run subprocess, a bounded fetch and a salvage push per lane, one at a time. Measured live on the real 90-lane pool: salvage refs for lanes 6, 18, 25, 26, 30 landed 12:45 to 12:52 (about 1.5-2 min per lane), so the 8-minute budget recovers about 5 lanes while 79 need work. Suggested fixes: (1) batch the git transport: one fetch for the whole pool, one push with several refspecs, instead of a node subprocess per lane; (2) run recovery during the scheduled gc pass so an acquire that finds the pool full rarely has to recover inline; (3) bounded parallelism (3-4 lanes) for the per-lane proofs. Also card: remove ignored --dry-run (fixed in 5855).

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
