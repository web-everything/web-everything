---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/merge-queue-adaptive-batching.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5217 (head bcab21bf8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5217 (reviewed head `bcab21bf87cdaaca5f6bd3b13fa1e429706d6001`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/merge-queue-adaptive-batching.mjs:322` — (edge-case, degraded) The unpaginated queue snapshot falsely identifies entries beyond 100 as ejected.
   - Scenario: Native queue contains PRs 1 through 101; persisted state tracks a queued group [101,1] with both members seen. The query returns only the first 100 entries, and PR view reports #101 OPEN. An injected-IO observation recorded a group failure, isolated [101,1], and successfully dequeued healthy #1 although #101 remained queued. The reader must paginate the connection or reject an incomplete snapshot rather than treating omitted entries as absent.
   - Claude's re-check: readQueueFacts uses 'entries(first:100)' with no pagination or truncation check. A PR at position 101 is missing from inQueue. If it is a seen member and 'pr view' says OPEN, observeQueue treats it as ejected, fails the group and dequeues the others.
2. `we:scripts/lib/merge-queue-adaptive-batching.mjs:565` — (failing-input, degraded) Replay silently abandons healthy PRs when their isolation deadline expires.
   - Scenario: Call replayBatching with standard settings plus enabled:true and maxGroupsInFlight:2, and ciMinutes:25. Supply six completed CI runs for PRs 1 through 6, created at minutes 0 through 5 and updated 25 minutes later, with branches gh-readonly-queue/main/pr-N-a. Conclusions are failure for #1 and #4, success for the other four. The unmodified function reports baseline.mergedPrs=4 but projected.mergedPrs=3. In-memory return instrumentation confirmed merged=[2,3,5] and stranded items=[6]. Isolation expiry removes #6 from recovery, but it never returns to pending admission; the loop terminates despi
   - Claude's re-check: Tracing the replay with the given inputs: the isolate list is [1..6] by the first two failures, and the third failure triggers strict mode with only 2 group slots. PR 6 is still deferred when the isolation timeout (60 min) expires at t=102, and expireIsolation drops it. It is in 'items' but not in 'pending', 'isolate' or any group, so the loop ends with merged={2,3,5}, 3 against a baseline of 4.

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
