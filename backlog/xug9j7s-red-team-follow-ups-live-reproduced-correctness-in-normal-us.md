---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/resource-pool.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7383 (head 305611c94)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7383 (reviewed head `305611c9436f0ece954bc77bd9081a6a90fddffc`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/resource-pool.mjs:28` — (failing-input, degraded) Queued fixes can strand the protected builder floor
   - Scenario: Call grantDecision with budget:4, held:[{source:'fixture',class:4,size:2}], queuedDemand:{3:2}, class:4, size:2. It returns hold because higher-class demand consumes the two free units. Requesting those units for class 3 also returns hold, citing builder floor. Both requests remain blocked while the fix stays queued. The builder request should grant its remaining two protected units; higher-class queued demand should reserve only capacity beyond the unfilled builder floor.
   - Class: live-reproduced (basis: A read-only Node probe importing we:scripts/lib/resource-pool.mjs reproduced both holds; removing queuedDemand lets the identical builder request grant. No concurrency or attacker assumptions are needed. The current effect is incorrect shadow allocation decisions.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

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
