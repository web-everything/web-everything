---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-stall-sweep.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7550 (head b413d7b50)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7550 (reviewed head `b413d7b507a5a0e74780d82ba91dccf20c029c28`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-stall-sweep.mjs:416` — (edge-case, degraded) Existing operator-queue entries suppress the new audit-repair notice.
   - Scenario: Have one open PR whose head already has a :needs-you entry in the feed's openKeys, then introduce a torn monthly audit row. The new repair item goes through publishStalledDigest, which filters it out because that head already has a REPORT_KINDS entry. No repair feed line or alert appears, leaving the sweep blocked without the promised repair notice. Audit corruption should remain visible independently of an existing PR-review notification.
   - Class: live-reproduced (basis: Executed the actual publisher and diffFeed function bodies with an in-memory filesystem. The same repair item emitted one feed line and one alert with empty openKeys, but zero lines and zero alerts with an existing matching :needs-you key; both runs returned no errors.)
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
