---
bornAs: xo3nc6q
kind: story
size: 2
status: open
scope: ["we:scripts/lib/gh-throttle-holders.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5326 (head 83b3d4142)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5326 (reviewed head `83b3d41427b5986492828e0da332484f4deed2b4`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/gh-throttle-holders.mjs:153` — (edge-case, degraded) Concurrent admissions bypass the per-caller cap
   - Scenario: With cap=6, perCallerMax=4 and three live slots belonging to worker, pause acquisition A after its snapshot but before trySlot. Let acquisition B for worker acquire the fourth slot, then resume A. A uses its stale three-holder snapshot and acquires a fifth slot. A deterministic in-memory probe of acquireGhHolderSlot returned ok=true for both acquisitions and callerHolds=5. Three concurrent acquisitions can similarly fill all six slots. Admission must enforce the caller count atomically with reservation so excess acquisitions wait and capacity remains available to other callers.
   - Claude's re-check: acquireGhHolderSlot computes capped() from a per-poll snapshot, then calls trySlot, which only guarantees atomic slot reservation, not the caller count. Two acquisitions with stale snapshots can both pass the cap check, so perCallerMax is exceeded.

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
