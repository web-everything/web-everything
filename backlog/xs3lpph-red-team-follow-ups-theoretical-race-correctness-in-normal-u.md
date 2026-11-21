---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [theoretical-race, correctness-in-normal-use] from web-everything/web-everything#7179 (head 90c488e82)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7179 (reviewed head `90c488e827fc5b989ea87352236fd326201744c8`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:5086` — (edge-case, broken) Guarded reclamation can discard a successfully renewed lease
   - Scenario: Trim evaluates a clean, expired legacy lease with no live recorded PID. Before trim claims it, a resumed worker's heartbeat successfully updates renewedAt. The guarded take still accepts it because sameLease compares only acquiredAt, session and holder. Trim can consequently delete the renewed worker's clean checkout. Reclamation should revalidate freshness under the guard and retain the renewed lease.
   - Class: theoretical-race (basis: A deterministic in-memory probe executed the actual sameLease and takeMarkerIf implementations: the renewed lease was non-stale, yet takeMarkerIf removed it. Concurrent CLI execution and subsequent checkout deletion were not exercised.)
   - Claude's re-check: demonstrated break
2. `we:scripts/lane-pool.mjs:2142` — (failing-input, degraded) Owned re-adoption erases existing scope and base metadata
   - Scenario: Acquire with --session=owner --adopt --base=poc/example --scope=we:scripts/example.mjs, then from that lane run acquire --lane=1 --session=owner --adopt. The new metadata-only path preserves checkout contents but rebuilds the lease without base or predictedScope. A competing scope query consequently changes from wait to launch. Re-adoption should preserve existing base and scope when replacement flags are absent.
   - Class: correctness-in-normal-use (basis: An in-memory probe executed the actual tryClaimLane implementation with filesystem writes captured and observed both fields disappear. The real candidateLaunch function returned wait with the original scope and launch after its removal. No concurrency or malformed input is required.)
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
