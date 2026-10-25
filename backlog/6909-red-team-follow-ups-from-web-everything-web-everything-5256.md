---
bornAs: xmgalgl
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5256 (head f52faad53)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5256 (reviewed head `f52faad53c7a71de2a43fad3c7efd125adfe1ba5`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:545` — (edge-case, degraded) A PR that merges before membership verification is falsely reported as an admission failure.
   - Scenario: Enqueue #42 successfully, then let GitHub merge it before the fast drain exits or its membership read completes. The child can return both enqueueOutcomes:[{num:42,outcome:'enqueued'}] and merged:[{num:42,mergedBy:'github-merge-queue'}]. Membership now returns isInMergeQueue=false, with an AddedToMergeQueueEvent in its history. An isolated Node probe executing the checked-out function bodies produced verified:false, 'NOT enqueued ... retrying on the next catch-up', and misses[42]=1 despite that successful merge. The membership query omits merged state, and the caller ignores json.merged. Recog
   - Claude's re-check: The membership query reads only isInMergeQueue, mergeQueueEntry and the queue timeline. It has no merged or state field, and the caller never checks merged state. If GitHub merges a PR that was just enqueued, or an already-queued PR, before the read, isInMergeQueue is false. The code then sets verified=false, writes 'NOT enqueued ... retrying on the next catch-up', and increments misses. The window is narrow, because merge-queue CI normally takes minutes. The effect is a misleading log line and miss count, not a lost merge. The race is still real in the code shown.

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
