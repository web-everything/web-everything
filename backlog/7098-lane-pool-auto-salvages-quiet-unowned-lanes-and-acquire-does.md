---
bornAs: xoaf9x8
kind: story
size: 3
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Lane pool auto-salvages quiet unowned lanes and acquire does not refuse while they exist

2026-10-25 11:59 ET: the lane pool filled to 90/90 with 76 unowned dirty lanes (52 finished-needs-review, 37 unknown-work, 0 reclaimable) and blocked all work about 2h until a manual R97 salvage reclaim (70 reclaimed). 2026-10-24 04:40 ET: the hard-cap check read the highest lane index (lane-999999 >= 90) instead of counting lanes, so the pool refused to grow. Want: auto-recovery salvage-reclaims quiet unowned lanes (salvage snapshot, then reset when no live process and quiet 30 min or more), a count-based cap that ignores fixture names, automatic reclaim of finished-reclaimable lanes in gc, and a needs-you event when acquire fails on a full pool. Prove on a live full pool; check whether #5859 covers it once merged. Related open card 4014.

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
