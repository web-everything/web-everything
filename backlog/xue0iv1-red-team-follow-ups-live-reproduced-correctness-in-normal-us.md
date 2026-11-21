---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/capacity-planner.mjs", "we:scripts/lib/provider-capacity-io.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7169 (head ef0642f78)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7169 (reviewed head `ef0642f780c248293e100dbf6955764b39af52d0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/capacity-planner.mjs:80` — (edge-case, degraded) Banked-reset planning carries usage across a scheduled quota reset
   - Scenario: At 2026-11-23T15:00Z, supply a restartOnReset window at 90% used, resetting at 16:00Z, length 168 hours, one banked reset expiring November 25 at 15:00Z, and demand of 1% per hour. planCapacity recommends a banked reset at 20:00Z and reports 5% forfeiture. The scheduled 16:00Z reset means actual usage at 20:00Z is only 4%, so forfeiture would be 96%. Advance scheduled resets before projecting banked-reset timing and forfeiture.
   - Class: live-reproduced (basis: A read-only Node probe returned the 20:00Z reset plan and 5% forfeiture; the horizon calculation independently reported 96% forfeiture for that same reset.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/provider-capacity-io.mjs:70` — (failing-input, degraded) Secondary Codex windows lose their burn-rate observations
   - Scenario: Record two Codex observations one hour apart with primary five-hour usage increasing from 11% to 12% and secondary weekly usage increasing from 71% to 72%, with unchanged reset timestamps. appendCodexUsage persists only primary quota data. When the weekly window binds, readCodexBurnRate rejects those primary reset timestamps and returns null instead of the observed weekly rate of 1% per hour. Consequently banked-reset pacing, score boosts and burn recommendations remain unknown. Preserve and select observations for each quota window.
   - Class: live-reproduced (basis: A Node probe captured appendCodexUsage output through an injected append function and supplied those bytes to readCodexBurnRate without writing files. The primary rate was 1; the weekly rate was null despite two supplied weekly observations.)
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
