---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/health-loop-ticks.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7417 (head b5eb38ca5)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7417 (reviewed head `b5eb38ca542713e5a36471f13364cc333aac3987`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/health-watch.mjs:1233` — (edge-case, degraded) An unreadable drain log can clear an existing drain alarm
   - Scenario: Open prepare and drain-catchup alarms using seven failed records per loop, ten minutes apart, ending at 12:00. At 12:16, let the drain log read fail with EACCES while the builder read supplies another failed prepare tick. The combined probe reevaluates both loops and emits a closed transition for drain-catchup despite observing no success. The unavailable source should leave its alarm unchanged.
   - Class: live-reproduced (basis: A Node probe against runHealthTick reproduced both opened transitions followed by drain-catchup closing while loopTicksDrain recorded EACCES and prepare remained open.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/health-loop-ticks.mjs:65` — (failing-input, degraded) Short configured windows alarm after only seconds
   - Scenario: Set WE_ZERO_SUCCESS_MINUTES=10 and supply three failed prepare ticks at now, now minus one second, and now minus two seconds. The smell returns breach=true because subtracting fifteen minutes makes the required span negative. A configured ten-minute observation window should require sustained failure rather than two seconds of evidence.
   - Class: live-reproduced (basis: Directly executed smell.evaluate with the supported ten-minute configuration; it returned breach=true with three failures and a summary reporting zero elapsed minutes.)
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
