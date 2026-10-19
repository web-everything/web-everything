---
bornAs: x4cfmzb
kind: story
size: 2
status: open
scope: ["we:scripts/lib/gh-throttle-holders.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5326 (head a4b18b2a0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5326 (reviewed head `a4b18b2a03b10aa7cdd19dd5bc8d6620d484bf07`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/gh-throttle-holders.mjs:74` — (edge-case, degraded) Concurrent admissions can exceed perCallerMax and fill all six slots
   - Scenario: With cap=6 and perCallerMax=4, start with three live holders attributed to worker. Three additional worker processes each snapshot those three holders before any acquires. All pass capped(), then independently acquire slots 3, 4 and 5. An in-memory probe executing the unchanged acquisition function with this interleaving returned success for all three, leaving six worker holders. Caller admission must coordinate the count check with acquisition so only one additional worker is admitted.
   - Claude's re-check: acquireGhHolderSlot computes capped() from a snapshot and then calls trySlot with no coordination. Several processes that all see 3 holders can each pass the check and acquire slots, so perCallerMax is exceeded.

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
