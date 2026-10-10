---
bornAs: x4y74wj
kind: story
size: 3
parent: "4124"
status: resolved
blockedBy: ["5670"]
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-followup-job.mjs"]
dateOpened: "2026-10-09"
dateResolved: "2026-10-10"
tags: []
---

# Drain follow-up job, wiring + live proof: merge-ai-prs records one drain-followup job per pass and returns

Slice 2 of 4124, after 5670 (the drain-followup kind). Waits on PRs 4624 and 4631 landing (they hold we:scripts/merge-ai-prs.mjs), or on card 5688's per-feature drain hook modules, whichever comes first — keep the merge-ai-prs edit to one call into a hook module. Behind a per-kind switch defaulting to inline (4120 adoption rule): replace the inline numbering/resolve-on-land/push/derived-regen block with buildFollowupInput (landedThisPass, landedCarriers, liveOpenHeadRefs) + enqueueJob into the drain's jobs dir (daemonJobsDir), and run reattachTick for the drain-followup kind at pass start so a dead job is resumed after a daemon restart; the worktree comes from makeFollowupWorktreePreparer off the drain clone. Also pin the numbering hash ledger to the state root (4120 Fork 2 note) and confirm releaseAndExit no longer kills the detached job. Done when: LIVE proof on the drain — a pass that merges 3 WE PRs ends within 90 s of its last merge, and the job record shows numbering and push done once (timestamps in the PR); before = inline jitNumbering ~11s, derivedRegen ~14s, postMergeSync ~7s in ~/workspace/plateau-app/.drain-daemon/daemon.log.

## Acceptance

- [A1] **Executable** — a wiring test (with the switch on, a pass that lands a local PR enqueues exactly one `drain-followup` job carrying `landedThisPass`, the carriers and the open head refs, and does NOT call `numberPendingHashes` or `regenDerivedOnLand` inline; with the switch off the inline path is unchanged) fails before this lands and passes after.
- [A2] **Live** — on the live drain, a pass that merges 3 WE PRs ends within 90 s of its last merge; the job record shows numbering and push done once; a daemon restart mid-job resumes the job, never starts it twice (timestamps in the PR).

## Non-goals

- [N1] The job's own robustness debt from #4679's review (short lock `waitMs`, heartbeat-false throws, parameterised reset/refusal test) stays on card 5643; this slice only wires the kind in and fixes its deps lookup (item 1 there).
- [N2] Operator decision 2026-10-10: the switch defaults ON (policy cascade `drainFollowupJob`, `we:scripts/settings/drain-followup-job.json`, env `WE_DRAIN_FOLLOWUP_JOB`), not inline as first written above.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the job input is the pass's own landed ids, carrier refs and open head refs, normalised to plain strings by `buildFollowupInput`; nothing is executed from it.
2. **Truncated reads** — the job re-derives numbering from fresh `origin/main` in every step; a corrupt job record is listed as corrupt and left alone by the reattach tick, never treated as absent.
3. **Shared state files** — one job folder per host (`~/.claude/daemon-jobs/drain-followup`), every record write under its file lock; the kind is serial, so a daemon pass and a lane's fast drain queue behind ONE writer to main.
4. **Fail closed** — any setup or enqueue failure returns `handedOff:false` and the pass runs the follow-up inline, so the numbering is never dropped; a failed reattach leaves the job queued for the next pass.
5. **Identity scoping** — the worktree is keyed by the launching clone's real path (`<jobsRoot>/drain-followup-worktrees/<hash>/main`), outside every git tree; its deps come from a parent-directory `node_modules` link to that clone.
6. **State over time** — the reattach tick runs every pass, so a job a dead daemon left is requeued and resumed from its checkpoint, or failed visibly after its attempt cap.
7. **Who wrote it** — the drain writes the record; the child claims it with a `host:pid:procStart` handle and every later write checks the record still names it.
