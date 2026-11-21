---
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7247 (head 23329491e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7247 (reviewed head `23329491e0747c5e25c9cfbc9bf350019062e300`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:583` — (edge-case, degraded) Runtime exclusions persist as 30-minute refusals after expiry or list updates
   - Scenario: Queue unprepared items 1 and 2. At 18:00:00Z, use an only-mode runtime record listing item 2, timestamped 17:00:01Z with ttlHours=1. Item 1 becomes a planning skip and is persisted in nextBookkeeping.prepareRefusals. Carry that bookkeeping into the 18:00:02Z tick: although the runtime list has expired, item 1 remains excluded for 30 minutes. Updating the runtime list to include item 1 also leaves it blocked. Runtime exclusions should be re-evaluated each tick rather than retained as prepare cooldowns.
   - Class: correctness-in-normal-use (basis: The new gate appends runtime exclusions to planningSkips. The existing persistence path saves every planning skip as a prepareRefusal, and freshRefusals excludes its item for PREPARE_REFUSAL_HOLD_MS without checking current runtime admission. This is a source-supported finding; the full tick probe could not run because dependency resolution failed.)
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
