---
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7251 (head 1ebcb27a6)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7251 (reviewed head `1ebcb27a6a67b0f157e2ca79ee9bb2e9c98d79f5`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:1392` — (failing-input, degraded) Planning-time refusals never enter durable history
   - Scenario: For card 5028, supply a prepare PR merged at 2026-11-18T11:40Z. Tick at 12:00Z and 13:00Z: both refuse it in planning, but recordPrepareRefusal is called zero times. Tick again at 2026-11-19T11:45Z: the daemon launches it because the merge guard expired and durable history is empty. Both refusals are still within 24 hours, so the repeat-refusal hold should prevent this launch. Planning skips must also reach the durable counter.
   - Class: live-reproduced (basis: Observed by running the production daemon and prepare planner with injected PR listings, clock, and in-memory history adapters. Both planning refusals were reported, history writes remained zero, and the final tick launched the card.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:skills-src/conveyor/build-dispatch-daemon.mjs:489` — (edge-case, degraded) An old attempt release exempts newer refusals from the hold
   - Scenario: Supply a settled prepare for card 5028 from November 17 with source run:old and its matching operator release. Supply two refusal-history rows from November 18 at 13:00Z and 14:00Z, then tick at 15:00Z with no blocking PR. The daemon reports no repeat-refusal skip and launches 5028. The released set is matched only by card number, so releasing an older attempt suppresses later refusals indefinitely until another settlement changes that set. The older release should not clear refusals recorded afterward.
   - Class: live-reproduced (basis: Observed through runBuildDispatchTick with the production prepare planner and injected history, settlement, release, and dispatch effects. Despite two recent refusal rows, skippedRepeatRefusal was empty and prepare.launched contained 5028.)
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
