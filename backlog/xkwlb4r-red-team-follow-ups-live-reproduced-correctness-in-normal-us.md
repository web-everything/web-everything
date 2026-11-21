---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/capacity-planner.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7169 (head 6566cd2c0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7169 (reviewed head `6566cd2c02c6811bef351f7aa5028ca3f357edc5`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/capacity-planner.mjs:79` — (edge-case, degraded) Banked reset planning ignores intervening scheduled resets
   - Scenario: At 2026-11-19T15:00:00Z, supply a restartOnReset weekly window at 90% used, scheduled to reset in one hour, lengthHours=168, currentRatePerHour=1, and one banked reset expiring 48 hours later. With default working hours, planCapacity schedules the banked reset for 20:00Z and reports only 5% forfeiture. However, the scheduled reset at 16:00Z clears usage first: at 20:00Z usage is only 4%, so the banked reset forfeits 96%. planHorizon reproduces that 96% forfeiture for the exact recommended event. The planner should process scheduled resets before projecting threshold crossings and calculating r
   - Class: live-reproduced (basis: Reproduced by calling planCapacity and planHorizon with the same injected window, inventory, clock, and usage rate. Their outputs report respectively 5% and 96% forfeiture for the same banked reset.)
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
