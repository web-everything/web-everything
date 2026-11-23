---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7401 (head 2e3485f96)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7401 (reviewed head `2e3485f9626681a41f6163e6a4472f3c839a14d8`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-merge-strategy.mjs:540` — (edge-case, degraded) Check-run holds never receive the planner-skip reason
   - Scenario: Set WE_RED_TEAM_GATE_SOURCE=check-run, provide an exact repo/PR/head queue entry blocked as planner-skip with blockedReason='later verdict or hold supersedes acceptance', and return a missing check from readRedTeamCheck. enqueue returns 'no red-team check run on head' without invoking readRedTeamQueueBlock. The hold should include the recorded planner reason in this supported mode too.
   - Class: live-reproduced (basis: An in-memory execution of the strategy implementation with mocked dependencies and GitHub/file I/O reproduced the generic hold and zero queue-reader calls.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/drain-merge-strategy.mjs:544` — (edge-case, degraded) Deadline escalation discards the annotated planner reason
   - Scenario: In drain-scan mode, provide an exact queue entry with blockedReason='later verdict or hold supersedes acceptance', missing red-team evidence, and deadlineAction=hold. The initial enqueue includes the reason. Advance the clock 45 minutes and enqueue again: the returned deadline hold and operator notification both omit it because heldReason replaces the annotated reason. Preserve the planner reason in the deadline outcome and notification.
   - Class: live-reproduced (basis: An in-memory execution with mocked dependencies and I/O reproduced the annotated initial outcome, followed by a deadline outcome and published operator note lacking the reason; the persisted wait still contained it.)
   - Also class: coverage-or-style
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
