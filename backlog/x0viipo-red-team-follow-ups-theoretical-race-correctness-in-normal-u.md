---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [theoretical-race, correctness-in-normal-use] from web-everything/web-everything#7179 (head 172952efb)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7179 (reviewed head `172952efb9141b165bc6512eb6e693c5224593d1`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:5047` — (edge-case, broken) Heartbeat renewal does not invalidate a pending stale reclaim
   - Scenario: A reclaimer evaluates a stale lease, then a heartbeat updates renewedAt before takeMarkerIf acquires the guard. Its sameLease predicate compares only acquiredAt, session and holder, so it accepts and removes the freshly renewed marker. Stale takeover or trim can consequently claim the active lane. The guarded stale-reclaim comparison must reject a renewed snapshot and recheck staleness.
   - Class: theoretical-race (basis: A deterministic in-memory replay of the production sameLease and takeMarkerIfGuarded functions removed a marker that renewedLease had made non-stale. The concurrent filesystem interleaving was not exercised.)
   - Claude's re-check: demonstrated break
2. `we:scripts/lane-pool.mjs:2134` — (failing-input, degraded) The availability picker still offers lanes the new liveness gate refuses
   - Scenario: Give lane-1 a clean tree and an expired lease whose holder PID remains alive, with lane-2 genuinely free. A fresh list --acquirable --limit=1 offers lane-1 because laneAcquirableInfo remains TTL-based. Acquiring that advertised lane under another session then fails with stale-but-live. Dispatchers can repeatedly select the unusable lane instead of lane-2. Availability selection should apply the same holder-liveness veto as acquisition.
   - Class: correctness-in-normal-use (basis: A read-only probe executed the production laneAcquirableInfo and isLaneAcquirable functions with clean-tree evidence and a real live process PID: availability returned true while probeLaneReclaim returned stale-but-live. The fresh scan passes that picker result directly into its output.)
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
