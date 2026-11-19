---
bornAs: x8crcnp
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/parked-pr-conflict-watch.mjs", "we:scripts/conveyor/stand-down.mjs", "we:scripts/conveyor/conflict-reassert-rule.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Conflict re-assert refuses on ANY stand-down in the thread, ignoring head scope, supersede and operator answer

Flow-sim gap R9a-G2, class K9 (divergent predicates for one state). Failing input: review:human + merge-status:conflicting PR, no review:changes, no live watcher marker. Thread holds an old trusted stand-down (e.g. ci-heal fix-loop park from buildStandDownComment, or a fixer stand-down on an earlier head, since answered or lapsed by a new push). 'Sweep after a conflict-fix round was re-armed without clearing … Cited: we:scripts/conveyor/parked-pr-conflict-watch.mjs:1577-1581, we:scripts/conveyor/stand-down.mjs:535-549, we:scripts/conveyor/conflict-reassert-rule.mjs, we:scripts/conveyor/reconcile-core.mjs:2569-2594. Soak-break sketch: Fixture: review:human + merge-status:conflicting PR at head B, thread has a trusted stand-down comment bound to head A (reconcile's countUnresolvedStandDowns returns 0 for head B), reviewHuman reassert setting on. Action: watch sweep. Assert (fails today): po…

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
