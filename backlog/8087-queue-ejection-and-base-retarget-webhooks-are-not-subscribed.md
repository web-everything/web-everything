---
bornAs: xqp4486
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/pr-events-worker/core.mjs", "we:scripts/lib/pr-events.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Queue-ejection and base-retarget webhooks are not subscribed, so the drain is not woken for them; recovery wa…

Flow-sim gap R7b-G5, class K15 (detector or report false negative). Failing input: PR in the GitHub merge queue, ready-to-merge. GitHub removes it (failed merge-group checks) and fires pull_request.dequeued / merge_group.destroyed; or a stacked PR's base is edited (pull_request.edited with changes.base). 'Webhook delivered to the Worker. Cited: we:scripts/conveyor/pr-events-worker/core.mjs:30, we:scripts/conveyor/pr-events-worker/core.mjs:407-410, we:scripts/lib/pr-events.mjs:163-170, we:scripts/lib/pr-events.mjs:49. Soak-break sketch: Fixture: replay a pull_request.dequeued payload through handleRequest. Assertion that fails today: a stored record exists and isRelevantEvent(rec,'drain') is true; today the answer is stored:false and no wake is produced.

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
