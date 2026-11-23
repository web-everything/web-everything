---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/merge-queue-enqueue.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7392 (head 882e663eb)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7392 (reviewed head `882e663eb6b1dfa26294ec1ddbebf187e496225f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/merge-queue-enqueue.mjs:516` — (edge-case, degraded) Removing the event filter exhausts recovery's single-page run limit
   - Scenario: A head has one historical pull_request_target Merge gate startup_failure and 100 newer runs from other workflow events. Previously the event-filtered request returned the single relevant run. The new unfiltered request returns 100 rows with total_count 101, so readMergeGateRuns throws before classification. Both recovery routes refuse to refresh the failed gate on every subsequent attempt. Recovery should paginate the complete result or otherwise retrieve complete relevant evidence without unrelated workflows exhausting its limit.
   - Class: correctness-in-normal-use (basis: A read-only probe invoked the real handleRequiredWorkflowsRefusal with an injected REST response containing total_count 101 and 100 returned rows. It returned handled:false with 'workflow run list incomplete or unreadable'. The changed request removes event filtering while retaining per_page=100 and no pagination.)
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
