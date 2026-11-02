---
bornAs: xvx26ux
kind: story
size: 2
status: open
scope: ["we:lane-pool.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# (Mac load)

HIGH priority hint. - (2026-10-31 23:06 ET) HIGH (Mac load): at 23:03 ET 6 concurrent 'git index-pack --stdin --fix-thin' each receiving ~115,700 objects (a WHOLE-repo pack) at 70–88% CPU, ≈445% CPU total git with no workers running. One traced parent: health-watch's 'we:lane-pool.mjs release --lane=79 --session=card-batch-seal-…' → its salvage push sends a full pack instead of a thin delta (likely the same root as 7337 'unknown transport config scope' / 'canonical origin unresolved'). Every lane release by a daemon re-ships the full repo. Fix: salvage push only lane-owned refs with a negotiated base (or skip when the lane has no unique commits); measure with trace2 before/after.

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
