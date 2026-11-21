---
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7251 (head 402871c4f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7251 (reviewed head `402871c4f010d23e41e78fc5b0eaf5c0ff029b64`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:496` — (edge-case, degraded) A completed stamp lifts the durable hold for only one tick.
   - Scenario: Start with two recent refusals for #5028 and a tracked prepare guard. Let readPrepareStatus return a completed stamp. That tick excludes the refusals and removes the guard. On the following tick, if changed scope requires another prepare, completedPrepares no longer contains the card and the unchanged durable records hold it again. Observed skippedRepeatRefusal change from empty on completion to two refusals next tick, with no prepare planned. Successful completion should invalidate the preceding refusal history so it cannot block subsequent work.
   - Class: live-reproduced (basis: Executed consecutive production daemon ticks with production prepare planning and in-memory refusal history. Completion removed the guard; the next tick resurrected the hold from the same two pre-completion records.)
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
