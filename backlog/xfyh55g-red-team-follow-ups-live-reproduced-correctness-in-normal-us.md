---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/health-smells/red-team-pending-overdue.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7418 (head 8f8c1a034)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7418 (reviewed head `8f8c1a034a49da37b320f469735842ef4a01bb10`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/health-smells/red-team-pending-overdue.mjs:19` — (edge-case, degraded) Overdue episodes remain open permanently after the PR head changes
   - Scenario: Open an episode for o/r#7 at head aaaaaaa with pending age 120 minutes and max 45. Push head bbbbbbb and remove pending. A fresh row with cachedLabels:false and labelsValid:true emits a clean observation only for bbbbbbb. Because missingSubjectsUnknown is unconditional, the aaaaaaa episode never closes, even on subsequent clean ticks. A complete empty inventory after merge likewise leaves it open. Verified replacement-head evidence should retire the obsolete episode while incomplete evidence remains unknown.
   - Class: live-reproduced (basis: Executed the actual smell and runHealthTick with an overdue head followed by fresh clear evidence for a replacement head. The original episode remained open both immediately and one day later, with no closed transition. Also reproduced persistence after a complete empty inventory using stepEpisodes.)
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
