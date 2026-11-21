---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Review follow-ups (round-budget, round 4) from web-everything/web-everything#7263

Filed mechanically by the unattended review loop: web-everything/web-everything#7263's review (reviewed head `b09d02f4dce491edcc21da22875784cb4cf9920c`) (finding set `e2ecc694c6a6211c`) was accepted because round 4 is past the round budget K=3 and no finding is broken (card 5471). Each finding below was deferred to this card instead of another fix round:

1. `we:scripts/conveyor/reconcile-core.mjs:1660` — correctness, CONFIRMED degraded: The diff rewrites three we:scripts/conveyor/reconcile-core.mjs lines that FIX_MARKERS in the fix-end-rearms-review soak break requires verbatim, so that break's fixPresent() flips to false and its suite goes red.

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
