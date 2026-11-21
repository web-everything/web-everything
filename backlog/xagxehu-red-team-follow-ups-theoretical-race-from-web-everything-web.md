---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/fix-dispatch-claim.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [theoretical-race] from web-everything/web-everything#7271 (head ee7c00684)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7271 (reviewed head `ee7c00684174bc02e8d375799fd0022690893d95`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/fix-dispatch-claim.mjs:452` — (edge-case, broken) The session-gone path can delete a claim renewed during the listing probe.
   - Scenario: Start with a runnerless fix claim whose acquisition and heartbeat are 31 minutes old, with a 10-minute lease. Sweep A snapshots it. During A's listing probe, sweep B sees the bound live session and refreshes its heartbeat to now. A returns an unrelated named row and releases the claim as session-gone. Reproduced with heartbeat age zero at removal: staleHeartbeat uses A's snapshot, while readUnchangedClaim does not compare heartbeatAt. A should retain the renewed claim by revalidating its current heartbeat before release.
   - Class: theoretical-race (basis: Deterministically reproduced using the real refresh function with filesystem operations redirected to an in-memory claim store and unrelated dependencies stubbed. Requires overlapping sweeps with differing listing snapshots; this timing was simulated, not observed in a live daemon.)
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
