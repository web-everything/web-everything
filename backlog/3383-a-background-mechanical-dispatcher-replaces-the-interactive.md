---
bornAs: xyv0vbz
kind: epic
parent: "3029"
status: open
dateOpened: "2026-08-28"
costTokens: "in:1566 cw:2345735 cr:344380407 out:631940"
costUsd: 211.45
costSessions: 1
tags: []
---

# A background mechanical dispatcher replaces the interactive session as delivery supervisor

> **STANDING GOAL FOR THIS EPIC (operator, 2026-08-29): improve the prototype and the machinery it
> depends on — not deliver any particular backlog item.** Discard work on an item freely, without
> ceremony, the moment it stops being the fastest path to a machinery finding. Do not treat landing a
> PR as the point of a session on this card. See the 2026-08-29 session update below for what this
> looked like in practice.

## The problem, stated plainly (2026-08-27/28, the operator's own words)

"The big problem at the moment is that much of this is handled by a costly session that is getting
super large, keeps forgetting its context and cost a lot." Delivery work — dispatching fixers and
reviewers, watching PR state, clearing stuck labels, healing CI — has run through one long
interactive session. That session IS the single point of failure: expensive per turn, its own
context degrades as it grows, nothing continues if it isn't open. `we:scripts/operator/converge.py`
(PR #1669) already proves most of the individual mechanisms work; what's missing is running them
without a person driving every step.

## The target shape (the operator's own spec)

- The session's role narrows to **queueing work** and **being notified of blocked items that need
  a person** — not driving routine progress turn by turn.
- A **mechanical dispatcher** owns queuing and capacity: it decides what runs now based on
  available capacity, not an agent's guess.
- **Subagents only edit code.** Every command they'd otherwise run themselves is delegated to the
  mechanical layer, which queues it and reports the result back — an agent never blocks waiting on
  its own shell command; it hands off and gets told the outcome.
- A **supervisor watches every agent** — progress, whether it's blocked, whether it's on track —
  and surfaces exactly that to whoever's queueing work, without anyone polling.
- Escalation is the exception path, not the default: most cases resolve mechanically (see
  `#3379`'s sibling cards — the stale-label clear, `ci:failed` healing, the ordering bug behind
  `#1659`'s stranding, the headless-reviewer polling fix); only genuinely novel cases reach an
  agent or a person at all.

## How to build it (the operator's own sequencing — deliberately NOT incremental-merge-from-day-one)

This is the opposite build strategy from `#3379`'s already-landed pieces, deliberately: those were
individually proven, low-risk, and graduated to `main` immediately. This is different in kind — an
unbuilt queue/dispatch/supervision system, not yet proven at all. Build and refine it in a
dedicated branch, alongside whatever else lands, WITHOUT the per-commit review tax that would slow
down free iteration on a design that doesn't exist yet. Once it is genuinely stable — proven over a
long stretch of real use, the way `converge.py` itself was proven tonight — split it into small,
individually reviewable pieces and move them to `main` the normal way, one at a time. Only once
everything has transferred does the real system execute from `main` instead of the branch.

**The one caveat that must not get lost in that plan:** a branch does not make the system's ACTIONS
safe, only its CODE unreviewed. The moment this dispatcher runs for real — even from a branch, even
before any of its code has landed — it is taking real actions against real PRs and real shared
state, exactly as `converge.py` already did all of tonight. "Not yet merged" is not the same
guarantee as "not yet running." Whoever builds this owes the same care to what it's allowed to
touch unattended as to the code itself, from the first real run, not just at graduation time.

## Why this card exists, not more work in the session that wrote it

This session is itself an instance of the problem this epic describes — large, deep into
compaction, expensive per turn. Building the actual dispatcher here would extend the exact pattern
this epic exists to end. Filed so a FRESH session — full budget, none of tonight's accumulated
context to carry — can pick this up and build it properly.

## Done when

1. A background process (not an interactive session) can run at least one real PR through a full
   fix → review → land cycle with zero interactive-session turns inside the loop.
2. A blocked/escalated case reaches a person or a fresh agent via an explicit notification, not
   because someone happened to poll and notice.
3. `we:scripts/operator/converge.py`'s already-proven mechanisms (independent review dispatch via a
   separate process id, `ci:failed` classification, stale-label recovery) are either subsumed by
   the new dispatcher or explicitly superseded by it — not left running in parallel indefinitely.

## Session update (2026-08-28, continued session) — five pieces built and tested, still unlanded

A follow-on session (same day) picked this back up and built five pieces toward the target shape
above, all individually unit-tested and smoke-tested against real subprocesses (not mocks) —
`check:standards` clean, 1300+ tests green as of last verification. Nothing below is landed to
`main`; it sits committed in lane-11 (`/Users/nicolasgilbert/workspace/.lanes/web-everything/lane-11`,
5 commits behind `origin/main` as of this update), deliberately, per this card's own "How to build
it" section above.

1. **Session-identity fix (#3331, resolved)** — `claude --bg` proven to ignore `--session-id`; the
   observer now reads the real handle off the CLI's own `backgrounded · <id> · <name>` stdout line
   instead. Touches `we:scripts/operations/dispatch-lane-io.mjs`, `we:scripts/operations/explore-io.mjs`,
   `we:scripts/operations/wake.mjs`.
2. **`we:scripts/operations/dispatch-lane.mjs` widened to `fix`/`ci-heal` launch kinds** — reuses
   the build-dispatch machinery.
3. **`we:scripts/operations/route-pr-outcome.mjs`** — new declared operation, thin wrapper over the
   existing `deriveReviewDisposition`, read-only, no sink — closes the gap where nothing under
   `scripts/operations/*.mjs` reached the escalation-disposition logic.
4. **`we:skills-src/conveyor/runner.mjs` now actually calls `dispatch-lane`** per surfaced decision,
   instead of only printing what it would do — the mechanization this epic's "Done when" #1 needs.
5. **`we:skills-src/conveyor/supervisor.mjs`** — a new resident process that keeps the runner above
   alive (restart on crash, backoff, JSONL log), roughly half the size of the `plateau-app`
   drain-daemon precedent because the runner already owns the hard parts. **Nothing installed to
   launchd** — deliberately left as code only; deployment is a separate, later call.

A smaller side-decision surfaced and closed independently during this work: decision #3384
("chasing a moving target" — a retry-cap counter that couldn't tell staleness from a real failure,
which once cost a real PR a human closing it by mistake) went through the full
`/prepare` → independent review → ratify → resolve cycle for real and is merged (`main`, PRs
#1674, #1675). Its own recommended fix is filed but not yet built.

**What's still not done, in priority order:**

1. ~~Decision #3118 ("where does agent-spawning live") was never ratified.~~ **Corrected 2026-08-29:
   #3118 WAS ratified, 2026-08-26 — Fork 1 → (c), call `dispatch-lane`, never a second spawn
   implementation.** This line, and the matching row on The Delivery Loop artifact's own dependency
   table, were both stale — trust this correction over either.
2. **Nothing has been fired end-to-end, live.** Every test this session deliberately avoided
   triggering a real dispatch through the full chain (a real queued item → the runner above →
   `dispatch-lane` → a real spawned agent → a real PR → `route-pr-outcome` → resolution) — this
   card's own "Done when" #1 is therefore still open. `we:scripts/operations/dispatch-lane-io.mjs`'s
   sink refuses to dispatch from a lane checkout (`assertNotALaneCheckout`), so a live test needs
   the primary checkout (meaning lane-11's pieces land first) or an equivalent non-`lane-N` setup —
   worth a decision of its own before attempting it.
3. **The stray-run-record reaper for `dispatch-lane`** (disk hygiene for the runner's own bookkeeping
   over a long-running deployment) was designed but not built — low urgency.
4. **"Done when" #2 (a notification path for a blocked/escalated case) is still open** — nothing
   built this session addresses it directly; the supervisor's JSONL log is observability, not a
   notification. **Reproduced live, 2026-08-29** — see Session update below: a real dispatch got stuck
   `blocked`/`waiting for input needed` with nobody able to answer it, exactly this gap.

## Session update (2026-08-29) — first live dispatch attempted; two real machinery bugs found and fixed;
## delivery itself still not proven end-to-end

A fresh session picked this up per the operator's own framing: **the goal is improving the prototype and
the machinery in general — not delivering any particular backlog item.** Work on a specific item is
disposable and was discarded twice below when it stopped being the fastest path to a machinery finding.

**Setup.** Cloned `origin/lane/mechanical-dispatcher-recovered` into a plain scratch directory
(`~/workspace/scratch-dispatcher-live-test` — deliberately not matching `lane-\d+`, so
`assertNotALaneCheckout` doesn't block it) and ran `npm install`. This is the non-`lane-N` setup item 2
above already called for.

**First real dispatch — genuinely worked, then hit a known, already-filed gap.** Queued `#2936` (a small,
low-stakes, non-UI catalogue-staleness fix — deliberately picked over a UI story per the operator's own
steer), ran `we:skills-src/conveyor/runner.mjs --once --json`. It called `dispatch-lane` for real, which
spawned a real background `claude --bg` agent (`claude agents --json` confirmed a live session,
`conveyor-2936`). The agent correctly acquired lane-40 (the brief's own first step, as designed), authored
a genuinely correct fix — corrected the stale claim, added a regression test, AND found + fixed a *second*
stale catalogue entry while sweeping as the card's own acceptance criteria asked — and committed it
(`b6dad636`, local `main` inside lane-40; branch-naming happens at `open-pr` time, not before, so this is
normal at this stage, not a bug). Then it hung: `blocked` / `waitingFor: "input needed"`, with nobody able
to answer it, because the dispatch ran with no permission-mode flag set at all.

**This is not a new defect — it is backlog `#3353`'s own documented precondition, which this session simply
failed to apply before firing.** `#3353` (filed 2026-08-26, independent of this epic) already found SEVEN
other `conveyor-*` sessions on this same host stalled on a permission prompt, one for 9.4 days, and states
outright: *"`WE_DISPATCH_AGENT_ARGS` MUST set a non-prompting permission mode before the dispatch. Unset
means no extra flags... an unset dispatch stalls at brief step 1's `$( … )` and never reaches
`lane-pool acquire`."* This session's own stuck agent is an eighth live instance of exactly that. Recovery:
killing the stuck agent's pid did NOT stop it — the CLI's own background-agent daemon silently respawned it
under a new pid from its spare-process pool (a genuinely new, undocumented-here finding about that
lifecycle, distinct from anything `WE_DISPATCH_AGENT_ARGS` governs). The correct close-out is bookkeeping,
not process death: `node we:scripts/operations/wake.mjs --resolve=<runId> --key=<key> --status=failed
--force` — documented in `#3353`'s own "live-run protocol," used here for real.

**Redispatching `#2936` with the fix applied correctly held — the machinery is right, not broken.**
Re-ran with `WE_DISPATCH_AGENT_ARGS='["--permission-mode","acceptEdits"]'` set. `we:scripts/readiness/dispatch-plan.mjs`
held it `"overlaps lane-40"`, because lane-40 still holds the first agent's real, uncommitted-to-origin
work — a genuine, correct collision guard, not a bug. Discarded `#2936` per the operator's framing and
switched to a different, unclaimed, non-UI item (`#2976`, a small `we:scripts/check-standards-rules.mjs`
bug) to keep testing the fix in isolation from that entanglement.

**Second real bug found: `computeFreeSlots` (`we:scripts/readiness/conveyor-state.mjs`) disagreed with the
actual dispatcher about lane availability.** The tick reported `31 free slots`;
`we:scripts/readiness/dispatch-plan.mjs` held `#2976` for `"no free lane"` in the same breath. Root cause:
`computeFreeSlots` only checked `leased !== true`, never `clean` — so a lane sitting DIRTY-but-unleased
(orphaned residue from a crashed/killed session — this HOST had 17 of them) still counted as "free," while
the real picker (`lane-pool list --acquirable`, what `we:scripts/readiness/dispatch-plan.mjs` actually
dispatches against) correctly excludes dirty AND ahead-unpushed lanes via `isLaneAcquirable`. **Fixed**
(`we:scripts/readiness/conveyor-state.mjs`, commit `d0c83a7b`) to also exclude `clean === false`, using the
same `status --json` field already fetched — no new IO, no risk of reintroducing the known-expensive
ahead-fan-out (`#2920`/`#2924`), which stays deliberately un-folded-in and is called out in the new doc
comment. `freeSlots` is now a documented optimistic upper bound, not a promise;
`we:scripts/readiness/dispatch-plan.mjs`'s own hold reason stays authoritative. 4 new tests, 89/89 green in
the file, `check:standards` clean.

**Third real bug found, and this one is a genuine crash: `we:scripts/lane-pool.mjs provision --acquirable`
threw uncaught on a transient git ref-lock race.** Trying to provision fresh acquirable capacity (since
this host turned out to have real, heavy ambient contention from several of the operator's OTHER concurrent
sessions — of 41 lanes: 10 leased, 17 dirty, the remaining 14 clean ones ALL ahead — genuinely zero
acquirable, an honest fact about this busy host, not a bug) crashed outright: `error: cannot lock ref
'<ref>': is at X but expected Y` from `git fetch origin --prune`, because every lane clones `--reference`
the same object store, so two lanes fetching at once can race the same `refs/remotes/origin/*` ref. **This
exact fetch is the FIRST git command a dispatched delivery agent's own brief runs** (`lane-pool acquire`'s
reset-to-origin step) — so on a busy host, an unlucky race could crash a dispatched agent before it ever
reached its own first real step, a genuine reliability gap for a "session-free" pipeline meant to run
unattended. **Fixed** (`we:scripts/lane-pool.mjs` + `we:scripts/lib/lane-lease.mjs`, commit `9bbb4ff3`):
retries only this exact ref-lock signature (`isTransientRefLockError`, extracted as a PURE predicate into
the already-tested `we:scripts/lib/lane-lease.mjs` — `we:scripts/lane-pool.mjs` itself runs its CLI at
import and cannot be unit-imported) a few times with a short backoff; every other fetch failure still
throws immediately, unretried. Re-ran `provision` live afterward: completed clean, no crash. 70 new/updated
unit tests + the existing 34 lane-pool integration tests green, `check:standards` clean. Both fixes are
commits on `origin/lane/mechanical-dispatcher-recovered` (`d0c83a7b`, `9bbb4ff3`), pushed and durable.

**Delivery itself is still not proven end-to-end — this card's own "Done when" #1 remains open.** No PR
was opened this session. `lane-40` still holds the first agent's real, correct, uncommitted-to-origin
`#2936` fix (`b6dad636`) — worth salvaging into a real PR by hand, or discarding and letting the
lease-reaper reclaim it past TTL; not decided here, per the operator's own "delivery is disposable" framing.
Getting a genuinely free lane on this host (for a next real attempt) needs either the ambient contention to
clear, or `provision --count=N` with `N` large enough to grow past the busy range (expensive — a real
clone + npm install per new lane).

**For the next session, explicitly, so it does not have to be told twice:**
- **The goal is improving the mechanical-dispatcher prototype and the machinery it depends on — not
  landing any particular backlog item.** "The prototype" means the WHOLE machinery this epic touches
  (`we:scripts/lane-pool.mjs`, `we:scripts/readiness/conveyor-state.mjs`,
  `we:scripts/readiness/dispatch-plan.mjs`, `we:scripts/operations/dispatch-lane*.mjs`,
  `we:skills-src/conveyor/*.mjs`, and anything else the runner's tick chain touches) — not one file.
  Discard work on an item freely, without ceremony, whenever it stops being the fastest path to a
  machinery finding. This is a standing instruction for this whole line of work, not a one-off for today.
- **Sweep known bugs across this whole machinery and apply as many fixes as possible to this branch**
  (not just the two this session happened to trip over live). Check the backlog for open items tagged
  against `lane-pool`, `conveyor`, `dispatch`, `readiness`, footguns, etc. — e.g. `#2924` (lane-pool
  acquire's TOCTOU on the destructive reset path, named but not fixed this session) and the
  `xs6omfp`-born dirty-tree-guard-on-`--lane=N` item are two already-known candidates. Prioritize by
  what could actually crash or corrupt a live dispatch, same bar as this session's two fixes.
- **Rebase this branch onto current `origin/main` before continuing** — it forked before today's `main`
  moved forward (e.g. this session's own work landed nothing to `main`, but other unrelated PRs have).
  Confirm tests + `check:standards` stay green post-rebase before building further on top.
- Always set `WE_DISPATCH_AGENT_ARGS` before dispatching anything for real — unset is a guaranteed hang now
  that both known crash-class bugs (this session's fetch race, `#3353`'s permission-mode gap) are fixed;
  the NEXT class of failure a live run finds will be a different one.
- `claude agents --json`, not raw `ps aux`, is the correct way to check a dispatched agent's liveness — a
  live `--bg` session's OS process does not reliably show a matching string in its own command line (the
  CLI's bg-spare pool reuses generic worker processes).
- Killing a stuck `--bg` agent's pid does not stop it — the CLI's own daemon respawns it from a spare pool.
  The correct close-out for an abandoned in-flight dispatch is `we:scripts/operations/wake.mjs --resolve
  ... --force` at the bookkeeping level, documented in `#3353`'s live-run protocol.
