---
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7248 (head bd92d3936)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7248 (reviewed head `bd92d39363f997be386e6ec7a715529ed016603c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1945` — (edge-case, degraded) The CI-heal child erases the parent daemon’s persisted resume cursors
   - Scenario: Start with a deferred fix recorded in we:.conveyor/fix-pass-cursors.json, for example prCursors.fix containing a repo cursor of 7248. Enable ciHeal.loop and let the child complete a cycle. runCiHealTick invokes runTickAllRepos with empty fix/promote-draft/notes ticks but retains its default cursor state and persistence path. Those empty phases delete their saved cursors, and the child writes the entire cursor document over the parent’s file. A subsequent daemon restart loses the deferred position and starts discovery again. The child should preserve phases it does not execute, using separate pers
   - Class: correctness-in-normal-use (basis: Source trace: both processes load the same default cursor file once; boundedPrTick deletes cursors when a phase returns no nextCursor; saveFixPassCursors replaces the whole document. Existing deferred state followed by one child cycle is sufficient, without simultaneous writes. The executable probe was blocked by missing markdown-it and gray-matter dependencies.)
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
