---
bornAs: x3n0zjx
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5859 (head b5b1b9b7d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5859 (reviewed head `b5b1b9b7d19aba0f29d7e69aef5c14ab524e4504`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:2775` — (edge-case, degraded) Salvage can exceed existing release deadlines and leave leases held
   - Scenario: Leave a coroner lane leased with HEAD ahead of origin/main, then run the nightly coroner's normal orphan sweep while origin's fetch stalls for over 30 seconds. we:nightly-coroner-job.mjs gives release --all-pools only 30,000 ms, but the new salvage fetch permits 120,000 ms and runs before takeMarkerIf removes the lease. The caller therefore terminates release before its 'releasing anyway' fallback, leaving the lease and registry mapping behind. A read-only injected-Git probe confirmed the 120,000 ms timeout; a scaled subprocess probe confirmed an outer deadline terminates salvage before cleanup i
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
