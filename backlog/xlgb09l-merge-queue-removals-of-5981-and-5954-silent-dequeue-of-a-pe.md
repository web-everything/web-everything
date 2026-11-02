---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/merge-queue-stuck-dequeue.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Merge-queue removals of #5981 and #5954: silent dequeue of a person-enqueued PR, and a still-live date-rot tes

MED priority hint. ## (held 2026-10-27 13:05 ET) Merge-queue removals of #5981 and #5954: silent dequeue of a person-enqueued PR, and a still-live date-rot test (1) #5981 (person-enqueued, gate-self) was dequeued by plateau-merger 49s after enqueue (16:52:52Z added, 16:53:41Z removed_from_merge_queue). daemon.log has no non-policy-cascade line for 16:52-16:54Z (the fast drain's say() output is not in daemon.log), so the path is inferred: sweepStuckEntries (we:scripts/lib/merge-queue-stuck-dequeue.mjs:58, kind 'unmergeable', via decideStuckDequeues), called from we:scripts/lib/drain-merge-strategy.mjs:670 inside dequeueSendBacks (we:scripts/merge-ai-prs.mjs:5451). Evidence: the drain merge-queue stuck state file has no 5981 entry (the sweep deletes dequeued PRs), and #5981's queue group was stacked on #5992's (branch pr-5981-e703e03... = #5992 group head). #5981 carries the same 100 commits and the CI workflow and the testing docs edits as #5992, which is still queued, so it conflicts behind it. The queue-file-overlap guard only gates drain enqueues, so a person's enqueue skips it. Fix: for a person-enqueued entry (no batching group, enqueue actor not the bot) the stuck sweep should hold and post a needs-you note naming the overlapping queued PR, not dequeue silently; and log every sweep dequeue to daemon.log. Proof required: before/after daemon.log line for a person-enqueued overlapping PR. (2) #5954 failed its 16:16Z merge_group CI (run 40539289321, job test-shard (6)) on we:scripts/__tests__/merge-ai-prs-merge-queue-hook-wiring.test.mjs "a transient UNKNOWN on the couple's fresh reads" (frozen-timestamp date-rot, same case as #5912). Not the PR's fault. Still unskipped on main (test line 390; only the line-239 case was skipped in 8e17cb6e3f). Fix: skip or unfreeze that case on main. Until then any queue group that runs shard 6 can fail.

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
