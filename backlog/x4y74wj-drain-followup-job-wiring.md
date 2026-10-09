---
kind: story
size: 3
parent: "4124"
status: open
blockedBy: ["xuy5acn"]
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-followup-job.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Drain follow-up job, wiring + live proof: merge-ai-prs records one drain-followup job per pass and returns

Slice 2 of 4124, after xuy5acn (the drain-followup kind). Waits on PRs 4624 and 4631 landing (they hold we:scripts/merge-ai-prs.mjs), or on card x5zjv3l's per-feature drain hook modules, whichever comes first — keep the merge-ai-prs edit to one call into a hook module. Behind a per-kind switch defaulting to inline (4120 adoption rule): replace the inline numbering/resolve-on-land/push/derived-regen block with buildFollowupInput (landedThisPass, landedCarriers, liveOpenHeadRefs) + enqueueJob into the drain's jobs dir (daemonJobsDir), and run reattachTick for the drain-followup kind at pass start so a dead job is resumed after a daemon restart; the worktree comes from makeFollowupWorktreePreparer off the drain clone. Also pin the numbering hash ledger to the state root (4120 Fork 2 note) and confirm releaseAndExit no longer kills the detached job. Done when: LIVE proof on the drain — a pass that merges 3 WE PRs ends within 90 s of its last merge, and the job record shows numbering and push done once (timestamps in the PR); before = inline jitNumbering ~11s, derivedRegen ~14s, postMergeSync ~7s in ~/workspace/plateau-app/.drain-daemon/daemon.log.

## Acceptance

- [A1] **Executable** — a wiring test (with the switch on, a pass that lands a local PR enqueues exactly one `drain-followup` job carrying `landedThisPass`, the carriers and the open head refs, and does NOT call `numberPendingHashes` or `regenDerivedOnLand` inline; with the switch off the inline path is unchanged) fails before this lands and passes after.
- [A2] **Live** — on the live drain, a pass that merges 3 WE PRs ends within 90 s of its last merge; the job record shows numbering and push done once; a daemon restart mid-job resumes the job, never starts it twice (timestamps in the PR).

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
