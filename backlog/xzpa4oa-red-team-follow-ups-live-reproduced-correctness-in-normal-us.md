---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/capacity-planner.mjs", "we:scripts/lib/codex-usage-ledger.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7169 (head 1af36c849)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7169 (reviewed head `1af36c849a829f5410ed94568b8af32d1e3568af`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/capacity-planner.mjs:78` — (edge-case, degraded) Banked reset planning ignores intervening natural resets
   - Scenario: At 2026-11-19T15:00Z, supply a restartOnReset window with 90% used, natural reset at 16:00Z, lengthHours=168, currentRatePerHour=1, and one banked reset expiring 2026-11-27T23:00Z. With default working hours, planCapacity schedules the banked reset at 20:00Z and reports 5% forfeiture. planHorizon correctly applies the intervening natural reset, then consumes that banked reset at only 4% usage and reports 96% forfeiture. Planning should advance through the natural reset and recompute when the fresh window reaches the reset threshold.
   - Class: live-reproduced (basis: Executed planCapacity and planHorizon with this input; observed the same banked reset showing 5% versus 96% forfeiture.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/codex-usage-ledger.mjs:100` — (failing-input, degraded) Weekly Codex burn rates cannot be recovered from newly written usage records
   - Scenario: Supply Codex readings whose primary window is five hours and secondary window is weekly. Record two observations an hour apart with primary usage 10% then 12% and weekly usage 28% then 29%; the current reading is primary 14%, weekly 30%. Capacity selects the weekly binding window, but appendCodexUsage persists only primary percentages and reset timestamps. readCodexBurnRate rejects every recorded sample because its primary reset differs from the weekly reset, returning null instead of the observed weekly rate of 1 percentage point/hour. Persist and select observations for the requested window
   - Class: live-reproduced (basis: Captured records produced by appendCodexUsage using injected persistence, then supplied those exact bytes to readCodexBurnRate through its injected reader. The weekly binding window returned null despite two recent weekly observations.)
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
