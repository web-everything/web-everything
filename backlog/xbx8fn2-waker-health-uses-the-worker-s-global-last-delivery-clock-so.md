---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/pr-events-worker/core.mjs", "we:scripts/lib/pr-events.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Waker health uses the Worker's GLOBAL last-delivery clock, so a dead webhook for one repo is masked by traffi…

Flow-sim gap R7b-G6, class K15 (detector or report false negative). Failing input: Daemon scoped to repos=[web-everything/web-everything], WE_PR_EVENTS=1. The webhook for that repo breaks (secret rotated -> 401, hook disabled); another repo on the same Worker keeps delivering, and ignored events keep calling touch(). 'Waker polls /events. Cited: we:scripts/conveyor/pr-events-worker/core.mjs:266, we:scripts/lib/pr-events.mjs:211, we:scripts/lib/pr-events.mjs:128-131, we:scripts/lib/pr-events.mjs:134-136. Soak-break sketch: Fixture: createEventWaker with repos=['a/b'], a poll stub whose lastDeliveryAt is fresh but every event is for 'c/d'. Assertion that fails today: health() is not 'healthy' for the scoped repo (interval stays base); today it is healthy and sleep uses the 10-mi…

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
