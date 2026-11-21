---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7220 (head c8a84403f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7220 (reviewed head `c8a84403fe74d2e7f7f3eaf4cbcb971f6231b351`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:4695` — (edge-case, degraded) Failed eligibility probes still enter the cache through list --no-cache
   - Scenario: With one unleased lane whose ahead-count probe fails, run list --acquirable --no-cache --no-reap with caching otherwise enabled. cmdList's separate writer at line 4752 caches an empty result despite laneEligibilityProbeFailed. Then run acquire --no-free-list --no-reap --wait-ms=0 --hard-max=2 before the cache expires, with origin reachable and unchanged lane metadata. The new process accepts that cache, never inspects the failed lane, and grows the pool. It should preserve the unknown-capacity result and block growth/recovery.
   - Class: correctness-in-normal-use (basis: A read-only VM replay executed production eligibility, cmdList, cache read/write, and cmdAcquire functions with injected Git failure and in-memory filesystem I/O. It recorded an empty cache while the failure flag was true, then reached growth in the subsequent process simulation with only one total eligibility inspection. No concurrency or attacker is required; the full CLI was not run.)
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
