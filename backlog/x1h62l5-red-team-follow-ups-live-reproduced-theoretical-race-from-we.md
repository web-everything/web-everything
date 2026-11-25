---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race] from web-everything/web-everything#7467 (head 99f43afd6)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7467 (reviewed head `99f43afd69ef184c04d818e4b83ff9f10597560b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2501` — (edge-case, degraded) Late hold refusals retain queue charges and block unrelated fixers
   - Scenario: Process PRs 1 and 2 with a real queue budget of one slot, 26.75 minutes backlog and the default 30-minute limit. PR 1 passes its admission hold read, charging 3.25 minutes, but its post-lane-selection read throws. The lane is returned, but the queue charge remains. PR 2 is then refused at a projected 33.25 minutes although no fixer launched and it should fit at 30 minutes. Reproduced the same outcome when dispatch returns the new push-hold refusal. Release unused admission reservations when a late hold prevents launch.
   - Class: live-reproduced (basis: Executed runReconcileFixDispatch with the real createQueueBudget and live hold parser, injecting a gh-port exception on PR 1's second read. Observed zero launches, PR 1 push-hold, PR 2 queue-cap, and 3.25 minutes retained demand. No concurrent mutation was required.)
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
