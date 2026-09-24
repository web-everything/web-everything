# Plateau observability review — 2026-09-24

The operator's reply to a 7-point improvement list: "Review items open for plateau I already ask for of that,
but I am sure we can improve". This review maps each point to the open backlog, adds what the day's incidents
taught to the cards that already own each area, and files new cards only where nothing owns the gap.
Plateau-app has no backlog of its own. Its cards live in we:backlog/ with `locus: plateau-app`.

Incidents used as grounding (all 2026-09-23/24): a stuck `blocked` session bound to a PR froze it for hours
(#3951); a daemon ran 9 commits behind main after the #4038 smoke gate rejected an update; the plateau-app lane
pool sat at 14/14 held; one bad App token failed every review session with HTTP 401 (#4039); drain slowness
could not be told apart from an empty input queue; a stacked PR had no owning daemon (#4030).

## Proposal → existing items → coverage → what was added

| # | Proposal | Existing items | Coverage | Added |
|---|---|---|---|---|
| 1 | Live daemon status page (per PR: state, owner, time in state, session, lane) | /wip daemon chips (4 daemons); #3931 epic (#3932–#3941) per-card agent activity; #4051 running revision; #4007 | Partly. Nothing gives the per-PR "who owns the next move, and are they alive" view | New WE card **xee72b2** (pr-ownership read). New plateau card **xqjl5lf** (/wip Fleet panel). #3932: transcript age field + shared PR→card map. #4051: `behindMain`, `lastRejectedSha`, cover verify and pass-daemons |
| 2 | Prose rules in briefs → code | #3643 / #3645 (wrappers own the lifecycle), #3593 / #3594 (slip scanner), #3721 (completion record as reap truth), #3752, #3730 | Partly. No inventory of which brief rules code enforces | New card **x446oxf** (brief-rule ledger, under #3593). #3643: the wrapper writes the completion record on every exit, not the agent |
| 3 | Daemon stall alerts | #4045 (outside heartbeat check), #3756 (runner-down alert), #3398 / #3487 (supervisor idle-with-queue), #4047 | Partly. Heartbeat-only; every stall on 2026-09-24 had a live heartbeat | #4045: four signals (heartbeat, behind main, owed-not-dispatched, 401 rate) and one alert path shared with #3756 and #3398 |
| 4 | Lighter lanes (worktrees) | #4015 (copy-on-write node_modules + git hygiene), #4014 (cap/recycle), #4016; #4028 and #4037 resolved today | Partly. Worktrees weighed nowhere | #4015: worktree vs clone fork. Recommendation: copy-on-write deps first, then measure |
| 5 | Workers survive interruption (conveyor builds daemon fixes) | #3984 (active: dispatcher as a resident daemon), #3487 (runtime core), #3645, #4002 / #4050 / #4040 (live overlays, restarts) | Partly. Blocked on the dispatcher running unattended | #3643: states the dependency chain (#3984 → #3487 → #3645) |
| 6 | Cost per daemon / bot | #3738 (usage by role and operation), #3943 /telemetry (model and role, no daemon), #4031 | Partly | #3738: daemon dimension + cost per outcome (per review, fix, landed PR) |
| 7 | Concurrency capped by machine load | #3612, #3807 (tracked budget), #3808 (capacity review), #3737, #3611, #3727 | Mostly covered | #3727: the ceiling must be shared across the now-separate daemons, and stale sessions counted as `held-by-stale` |
| — | Drain slowness | #2606 program, #3569 | Partly | #3569: per-daemon throughput and input-state wait; show on /telemetry and /wip instead of a third page |

## Top 5 by leverage ("have all daemons live so we can mechanise all this")

1. **Dispatcher live unattended: #3984 → #3487.** Until the build dispatcher runs as a daemon, every fix
   (including daemon fixes) needs an in-chat worker that dies with its chat. This unblocks proposal 5.
2. **Fleet stall alerts: #4045 (with today's additions) + #4051.** Every stall today had a live heartbeat. The
   behind-main and owed-not-dispatched signals would have caught the 9-behind freeze and #3951 within minutes.
3. **PR ownership: xee72b2 → xqjl5lf.** One read answers "why is this PR not moving" for the whole fleet. It
   replaces the hand transcript reading that cost the most time today.
4. **Wrapper-owned lifecycle: #3643 / #3645 + ledger x446oxf.** It removes the recurring "agent forgot step X"
   failures at the source and makes "rules left in prose" a number that goes down.
5. **One shared budget across daemons: #3727 on #3807.** Once all daemons run, three independent dispatchers
   will over-admit without it. Stale sessions must not silently starve the pool.

Lower: #4015 (lighter lanes: helps disk and CPU, not liveness), #3738 (cost per daemon: useful once daemons run
long enough to measure), #3569 (throughput trends).

## Not changed

The new cards were filed with `--queue=false`: they need an operator look before the conveyor picks them up.
#3984 is `active` (in flight on another lane), so it was left untouched; its dependency is recorded on #3643.
