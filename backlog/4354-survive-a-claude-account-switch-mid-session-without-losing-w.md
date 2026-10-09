---
bornAs: xlou1je
kind: story
size: 8
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/conveyor/lease-reaper.mjs", "we:scripts/conveyor/session-reaper.mjs", "we:.claude/commands/handoff.md", "we:.claude/commands/continue.md", "we:scripts/operations/handoff-home.mjs", "we:scripts/lib/github-app-token.mjs"]
dateOpened: "2026-09-28"
tags: []
---

# Survive a Claude account switch mid-session without losing work

2026-09-28 ~11:30 AM ET: the operator switched Claude accounts mid-session. The orchestrating session resumed fine (its transcripts are local), but its 3 in-process background workers stopped with no completion record, and 2 of them lost their we:scripts/lane-pool.mjs leases while holding uncommitted/unpushed work (lane-5: 1 unpushed commit + scratch; lane-8: 6 uncommitted files) that we:scripts/conveyor/lease-reaper.mjs could instead have reclaimed and reset. One worker's follow-up commit never reached its own PR and had to be rescued by hand from the abandoned lane's object store. Separately, the iOS Code tab was slow to surface the resumed session, and daemons silently run as whichever account the CLI happens to be logged into, with no visible record of which account did the work. Ask: (1) make a lane lease survive its owning session stopping by tying it to the lane's actual content (commits/diff), not only the live process, so a stopped worker's work is never silently orphaned; (2) a resume checklist/command listing stopped workers plus each one's lane state (clean/committed/pushed); (3) a documented, checkable note on which account each daemon authenticates as.

## Evidence (2026-09-28 ~11:30 AM ET)

- (a) the orchestrating session's 3 in-process background workers were stopped by the account switch with no
  completion record anywhere the resumed session could read.
- (b) two of them held live we:scripts/lane-pool.mjs leases with real unpreserved work when they stopped —
  lane-5 (1 unpushed commit + scratch) and lane-8 (6 uncommitted files) — which we:scripts/conveyor/lease-reaper.mjs
  could have reclaimed/reset instead of leaving to go stale or be hand-rescued.
- (c) one worker's follow-up commit (registering the #4337 soak break) never reached its own PR (#2841, merged
  without it) and had to be cherry-picked by hand out of the abandoned lane's object store before it was reset
  out from under this task — see the sibling rescue in this same PR.
- (d) the iOS Code tab took a noticeable while to show the resumed session.
- (e) daemons authenticate as whichever account the CLI (`gh`/`claude`) is currently logged into
  (we:scripts/lib/github-app-token.mjs) — an account switch changes who a daemon acts as with no visible signal.

## Asks

1. A lane lease that survives its OWNING SESSION stopping — tie the lease's liveness signal to the lane's own
   content (has it got commits ahead of origin? uncommitted changes? scratch?) rather than only to whether the
   spawning process/session is still alive, so we:scripts/conveyor/lease-reaper.mjs (and the acquire-time
   backstop in we:scripts/lane-pool.mjs) never treats "session gone" as "safe to reap" when real work is sitting
   there unpushed.
2. A resume checklist/command: on `/continue` (we:.claude/commands/continue.md, backed by
   we:scripts/operations/handoff-home.mjs) or an equivalent fresh-session entry point, list every background
   worker the prior session had in flight, whether it's still alive, and — for each one holding a lane — that
   lane's state (clean / uncommitted / committed-unpushed / pushed). Today a resumed session has no way to learn
   this short of manually walking `we:scripts/lane-pool.mjs status`/`list` and guessing which lanes are its own
   orphans.
3. A documented, checkable note on which account each daemon runs as (surfaced from
   we:scripts/lib/github-app-token.mjs / `gh auth status`), so an account switch is visible instead of silently
   changing who a daemon acts as mid-run.

## Risks

- Ask 1 must stay fail-closed in the SAFE direction only: broadening what counts as "still live" must never let
  the reaper miss a genuinely dead, empty lane it safely reclaims today — it should only make it MORE reluctant
  to reap a lane carrying real unpreserved content.
- This is exploratory: none of the three asks has a chosen mechanism yet, so this card intentionally does not
  prescribe one (e.g. "poll the CLI's active account on an interval" vs. "stamp the account into the lease at
  acquire time" are both live options for ask 3).

## Ruling (operator, 2026-10-09 ~13:05 ET)

The open choice from the prepare run (how a resumed session learns which background workers were running) is
ruled **(c) both**:
- **Source of truth: a launch record.** A hook on the agent-launch tool writes each background worker's id,
  purpose, lane and session to a durable record at launch. No caller discipline; the hook does it.
- **Fallback: reconstruction at resume.** The resume command also walks lane leases and lane content-state and
  lists any lane with no matching launch record, so workers started before the hook (or outside it) are not lost.
- Unchanged and not in question: the lease reaper never reclaims a lane carrying unpreserved work (ask 1, safe
  direction only).

## Done when

1. **Executable** — TODO (no tier-1 command yet; each ask needs a design decision before a test can pin it).
   Tier-3 acceptance: after a mid-session account switch, a resumed session can, via one documented
   command, list every stopped background worker and its lane's content-state, and a worker's own
   unpushed/uncommitted work is never silently dropped the way this incident's items (b) and (c) were.
