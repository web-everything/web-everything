---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [theoretical-race] from web-everything/web-everything#7179 (head 0a4819fbc)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7179 (reviewed head `0a4819fbc65fcc7ea8ef7a637052faf4e5cb8543`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:2174` — (edge-case, broken) Stale takeover can discard a lease renewed before acquiring the guard
   - Scenario: A reclaimer reads a stale lease and passes the holder/worktree/CWD checks. Before takeMarkerIf acquires its guard, the worker renews that lease, making it fresh. takeMarkerIf still accepts it because sameLease compares only acquiredAt, session and holder, ignoring renewedAt. The reclaimer removes the fresh marker and claims the lane. A deterministic in-memory probe executing the actual claim and marker-taking functions returned new-holder after inserting a fresh renewal at this boundary. The guarded check should reject a renewed snapshot or recheck its TTL before takeover.
   - Class: theoretical-race (basis: The forced interleaving reproduced the incorrect takeover in memory, without concurrent live processes. It assumes the original acquiring PID has exited and no process CWD was inside the lane at the earlier probe, while a worker operating from another directory renews the lease.)
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
