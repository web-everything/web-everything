---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/capacity-planner.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7169 (head 04016c9f3)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7169 (reviewed head `04016c9f37f10a31e416593a5f0c65108e8bb263`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/capacity-planner.mjs:129` — (failing-input, degraded) The horizon forecasts usable capacity while the weekly quota remains exhausted
   - Scenario: Call planHorizon at 2026-11-19T00:00:00Z with days=3, demandPerDay=24, UTC calendar days, and one Codex restartOnReset capacity with no banked resets. Supply windows in this order: five_hour at 100%, resetting in 1 hour, lengthHours=5; weekly at 100%, resetting in 120 hours, lengthHours=168. The forecast reports day-two available=122 and shortfall=false, followed by day-three available=123 and shortfall=false. plannerWindow selects only the five-hour window and the horizon repeatedly replenishes it, ignoring the exhausted weekly constraint. Available capacity must remain zero, with shortfalls,
   - Class: live-reproduced (basis: A direct Node invocation of planHorizon produced these values. Both quota windows are exhausted, so the failure does not depend on converting percentages between differently sized windows.)
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
