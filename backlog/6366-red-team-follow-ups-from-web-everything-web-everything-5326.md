---
bornAs: x1dzmxx
kind: story
size: 2
status: open
scope: ["we:scripts/lib/gh-throttle-holders.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5326 (head bf097ec32)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5326 (reviewed head `bf097ec320e9fb1563b10bd8b3c618274d133b0e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/gh-throttle-holders.mjs:152` — (edge-case, degraded) Concurrent acquisitions bypass the per-caller cap and can monopolize all six slots.
   - Scenario: With cap=6 and perCallerMax=4, start with three live slots belonging to worker. Three additional worker processes each snapshot those holders before any acquires a slot. Each passes capped(), then trySlot independently acquires a different free slot; admission never rechecks the caller count. A deterministic in-memory interleaving of the actual acquireGhHolderSlot function returned ok=true for slots 3, 4 and 5, leaving six worker holders. Admission should enforce the caller limit across concurrent acquisitions, preserving slots for other callers.
   - Claude's re-check: In acquireGhHolderSlot, capped() is evaluated only on the pre-acquire snapshot. trySlot then takes any free slot, and the caller count is never rechecked after acquisition. Three processes that snapshot the same three worker holders each pass the cap and take different free slots, which gives six worker holders.

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
