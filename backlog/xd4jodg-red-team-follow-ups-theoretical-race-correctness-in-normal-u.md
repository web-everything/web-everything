---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [theoretical-race, correctness-in-normal-use] from web-everything/web-everything#7179 (head df425220e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7179 (reviewed head `df425220e16e35c762f143c28d4d1d1e01d72bc9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:2128` — (edge-case, broken) A heartbeat renewal does not invalidate a pending stale takeover
   - Scenario: Acquire reads a stale lease with a dead legacy PID, confirms a clean tree and no live cwd, then pauses before takeMarkerIf. The holder's heartbeat renews the lease. Acquire resumes: sameLease compares only acquiredAt, session and holder, so it removes the freshly renewed marker and successfully claims the lane for another session. The guarded takeover must recheck expiry or compare renewedAt before removing the marker.
   - Class: theoretical-race (basis: A deterministic in-memory interleaving executed the production tryClaimLane and takeMarkerIfGuarded functions. The renewed marker was non-stale, yet claim returned new-holder and finalSession became other. Concurrent filesystem execution was not tested.)
   - Claude's re-check: demonstrated break
2. `we:scripts/lane-pool.mjs:2124` — (failing-input, degraded) Owned re-adoption drops existing base and scope metadata
   - Scenario: Acquire a lane with --base=poc/target and --scope=we:scripts/lane-pool.mjs. From that lane, run acquire --lane=1 --adopt --session=&lt;existing-session&gt; without repeating those flags. The new metadata-only renewal preserves the checkout but rebuilds its lease without base or predictedScope. It should preserve the existing metadata when renewing the same hold.
   - Class: correctness-in-normal-use (basis: Executing the production tryClaimLane function with in-memory marker IO preserved existing-holder but changed laneBaseRef from poc/target to null and removed predictedScope. The new renewOwnLease path uses this same-session branch.)
   - Claude's re-check: demonstrated break
3. `we:scripts/lane-pool.mjs:2128` — (failing-input, degraded) Acquirable listings include lanes the new liveness gate refuses
   - Scenario: Leave a clean, fully pushed lane with a TTL-stale lease whose holder PID remains alive. list --acquirable --no-cache --no-reap advertises it because laneAcquirableInfo and isLaneAcquirable check TTL and tree state without holder liveness. A foreign acquire then refuses that same lane as stale-but-live. Dispatchers consequently overcount usable capacity and select unavailable lanes. Listing eligibility should apply the same liveness restriction.
   - Class: correctness-in-normal-use (basis: A read-only runtime probe returned listedAsAcquirable=true from isLaneAcquirable while probeLaneReclaim returned safe=false with stale-but-live for the identical lease. Source inspection confirmed scanAcquirable uses the former decision without the new reclaimSafety check.)
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
