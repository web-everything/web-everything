---
bornAs: xbbhtmd
kind: story
size: 3
status: active
scaffoldedBy: "fix-5480"
dateScaffolded: "2026-10-18"
scope: ["we:scripts/lib/merge-queue-enqueue.mjs", "we:scripts/merge-gate-check.mjs", "we:scripts/lib/drain-merge-strategy.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Enqueue: re-confirm the PR base after the enqueue mutation, refuse a retarget, and read merge-gate changed files against the PR's own base

Follow-up from PR #5480 self-review (fix-5480, 2026-10-18). Three gaps of the stale-base class, none introduced by #5480 and all equal on the prepared and unprepared enqueue paths:

1. enqueuePr (we:scripts/lib/merge-queue-enqueue.mjs) reads baseRefName once (gh pr view) and the enqueue mutation pins only expectedHeadOid; the post-enqueue confirm (readMergeQueueState) reads isInMergeQueue + headRefOid, not the base. A retarget or base force-push between that read and the mutation enqueues a change list judged against the old base. Fix: confirm baseRefName (and base tip) after enqueue; hold as base-moved (dequeue if needed).
2. enqueuePr re-reads the diff on a retarget but then enqueues into the new base; neither the drain's readLive (we:scripts/lib/drain-merge-strategy.mjs) nor enqueuePr compares the live base with the judged base. Mirror the head-moved refusal with a base-moved one.
3. we:scripts/merge-gate-check.mjs reads the pinned changed files against defaultBranch, not the PR's base; for a queue-enabled non-default branch the merge-group backstop judges the wrong diff.
Also: gh pr view / git fetch in readPinnedChangedFiles and enqueuePr have no timeout (widens window 1).

Acceptance: a named test per gap, each red before and green after.

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
