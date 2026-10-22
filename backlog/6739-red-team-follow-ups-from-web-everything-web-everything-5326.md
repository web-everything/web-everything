---
bornAs: xkgzsah
kind: story
size: 2
status: open
scope: ["we:scripts/lib/gh-throttle-holders.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5326 (head 177c8290c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5326 (reviewed head `177c8290c328160402ce842546ef21be71f0a9d6`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/gh-throttle-holders.mjs:114` — (edge-case, degraded) Concurrent acquisitions can bypass perCallerMax and fill all six slots.
   - Scenario: With cap=6 and perCallerMax=4, let caller worker hold slots 0–2. Start three more worker acquisitions, each taking its snapshot before any acquires a slot. All see three holders and pass capped(); the atomic slot primitive then admits them into distinct slots 3–5. A deterministic in-memory interleaving of acquireGhHolderSlot reproduced all three returning ok:true, leaving six worker holders. The caller count check and reservation must be coordinated so only one additional worker acquisition succeeds and two slots remain available to other callers.
   - Claude's re-check: The 'capped()' check runs on a snapshot taken before 'trySlot', and the two aren't coordinated. Several same-caller acquirers can each see fewer than perCallerMax holders and then take distinct free slots, so the cap is exceeded.

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
