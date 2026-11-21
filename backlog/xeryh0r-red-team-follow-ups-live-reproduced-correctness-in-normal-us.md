---
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7247 (head 30dd4490f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7247 (reviewed head `30dd4490fbfc8e4656618a23469c3e1550bb3e65`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:583` — (edge-case, degraded) Off-list skips become persistent 30-minute prepare refusals
   - Scenario: Queue card 1 needing preparation and tick with runtime only-list containing 2. The new gate adds card 1 to planningSkips, which nextBookkeeping persists in prepareRefusals. One minute later, change the list to contain 1 or let the original list expire. Despite current settings allowing card 1, freshRefusals still excludes it from planning. The probe launched nothing after one minute and launched card 1 only after 30 minutes. Runtime exclusions should be reevaluated each tick without entering the prepare-PR refusal cache.
   - Class: live-reproduced (basis: Reproduced both list-update and expiry sequences using the actual runBuildDispatchTick, readBuildPrioritySettings, shapeQueue, and planPrepareSpawns functions with injected IO and simulated time. Missing unrelated parser dependencies were stubbed in memory; dispatches were recorded rather than launched.)
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
