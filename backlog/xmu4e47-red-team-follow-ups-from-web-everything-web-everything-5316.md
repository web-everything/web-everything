---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5316 (head fb0e95779)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5316 (reviewed head `fb0e957790a463c1fc9fe088229e22a1bcd2a03e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:718` — (edge-case, degraded) Active-PR filtering discards fresh events for a replacement head
   - Scenario: With catch-up disabled, start an event drain for PR #42 at head A. While its child runs, update the PR to head B and deliver B's successful check-suite event through notePoll. The activeNums filter discards that event. Finish the child with revalidationAborted for the changed head, advance beyond debounceSeconds, and tick again. The probe observed one total spawn and an empty pending list: B never receives its event drain. Retain or coalesce the new event for processing after the active attempt finishes.
   - Claude's re-check: notePoll now drops any marked event whose PR is in activeNums, and activeNums includes event-driven children. A fresh check-suite event for the new head, arriving while the old-head child runs, is discarded rather than kept pending. With catch-up off, nothing re-queues it.
2. `we:scripts/lib/enqueue-on-event.mjs:619` — (edge-case, degraded) Shutdown during an event PR read permits an un-killed child to start
   - Scenario: Queue an ordinary event, call tick(), and suspend readPr. Call kill(), then resolve readPr with an open, ready, green PR. The event path does not recheck stopped after the await, so it starts a child after kill has already traversed children. The probe observed spawnsAfterKill=1 and kills=0. Shutdown must prevent this start, as the added shutdown requirement claims; check stopped immediately before spawning for event work too.
   - Claude's re-check: The diff adds a 'stopped' recheck only inside the 'p.catchUp' branch, after its awaits. The event path awaits the PR read (existing code) and then spawns with no 'stopped' check. If kill() runs during that await, 'children' is still empty, so the child spawns afterward and is never killed.

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
