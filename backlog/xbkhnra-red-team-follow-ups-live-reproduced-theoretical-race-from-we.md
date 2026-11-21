---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-heal-loop.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race] from web-everything/web-everything#7248 (head 483424db3)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7248 (reviewed head `483424db36c723c0d2332fa32fdb34cad833ad16`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/ci-heal-loop.mjs:82` — (failing-input, degraded) Controller-driven restarts bypass the supervisor's minimum retry interval.
   - Scenario: With ciHeal.loop enabled, let spawnLoop throw EAGAIN. Call controller.tick() again 1 ms later, before the scheduled retry fires. It immediately attempts another spawn and schedules another retry. Startup and handoff-driven ticks can therefore repeatedly retry during resource exhaustion. The second attempt should wait until the 60000 ms minimum gap expires.
   - Class: live-reproduced (basis: Executed the actual controller and supervisor function bodies in memory with an injected EAGAIN spawn failure and controlled clock. Two ticks at times 0 and 1 produced spawn attempts at both times and two 60000 ms retry timers; no timer callback was invoked.)
   - Also class: theoretical-race
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
