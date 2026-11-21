---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/capacity-planner.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7169 (head 5c8781cc4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7169 (reviewed head `5c8781cc4a76f0558b91fce44ce3372f13ed8aef`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/capacity-planner.mjs:172` — (failing-input, degraded) Rolling quotas incorrectly cap daily supply at one window
   - Scenario: Call planHorizon at 2026-11-23T00:00:00Z with an active rolling account at 0% usage, lengthHours=5, resetsAt=now+5h, demandPerDay=200, days=3, and continuous UTC working hours. Include an inactive account for the same provider. Every day reports available=100 and shortfall=true, then recommends activating the inactive account. This quota supports 480 percentage points per day; demand of 200 should produce no sustained shortfall or activation recommendation.
   - Class: live-reproduced (basis: Reproduced through the exported planHorizon function. The same input produces allowedRatePerHour=20 in planCapacity, exceeding the requested demand rate of 8.33 per hour.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/capacity-planner.mjs:64` — (edge-case, degraded) Fixed-window accounts ignore their banked resets when recommending resets
   - Scenario: Use the shipped claude-a definition and attribute a fresh seven_day reading of 97% usage to it at 2026-11-19T15:00:00Z, with reset five days later and queuedDemand=1. Its configured banked reset remains valid through December 10. planCapacity returns action=slow and burnWindows emits no reset recommendation because fixed windows return before examining inventory. Meanwhile, planHorizon with demandPerDay=24 schedules that banked reset immediately. The current planner should recognize the available manual reset and recommend it during working hours while retaining the fixed natural-reset schedul
   - Class: live-reproduced (basis: Reproduced with readProviderCapacity using the shipped Claude configuration, followed by planCapacity, burnWindows and planHorizon. The current planner ignores the reset that the horizon explicitly consumes at the same timestamp.)
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
