---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/repo-health.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, theoretical-race] from web-everything/web-everything#7470 (head ae46e8e61)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7470 (reviewed head `ae46e8e6163df563d993ca097c914587756b503d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/repo-health.mjs:37` — (edge-case, degraded) A PR created during the scan invalidates otherwise complete repo health and suppresses stale alerts
   - Scenario: Start runCli at 2026-11-25T12:00:00Z. Return complete API results containing an old open PR created on November 20, no merges, and a new PR created at 12:00:01Z while the requests were running. readAllHealth retains the scan-start clock, so the new PR triggers 'PR timestamp in the future'; the CLI exits 1 and omits the stale alert owed for the old PR. Removing only the new PR restores that alert. Creation timestamps valid at read completion should not invalidate the repo's health or suppress its existing stale alert.
   - Class: correctness-in-normal-use (basis: Established by tracing the code, not by running it. The clock is captured once when the scan starts, the network reads happen afterwards, and any open PR created later than that instant makes the whole repo unknown, which drops its stale alert and makes the CLI exit nonzero. Merge times get a tolerance but open PR times do not. It needs only ordinary PR creation during a scan. The window is narrow and a later run would likely recover.)
   - Also class: theoretical-race
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
