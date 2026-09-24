---
bornAs: x6einv9
kind: decision
parent: "3383"
status: resolved
dateOpened: "2026-09-14"
dateResolved: "2026-09-23"
codifiedIn: "docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle"
preparedDate: "2026-09-23"
preparedAgainstSha: "57cbd30434e523419d4c986f9e51276dfd63b763"
relatedTo: ["3625", "3467", "3397", "3756", "2501", "3443", "3649", "3952", "3954", "3984"]
relatedReport: reports/2026-09-23-daemon-lifecycle-staleness-reload-prep.md
tags: [daemons, ops, staleness, live-reload, decision-prep]
---

# Mechanize long-running daemon lifecycle: health-check, staleness detection, and live-reload

**Digest.** Most of this decision is no longer open in practice. Since the first prep (morning of 2026-09-23), the
operator directed that daemon staleness "has to happen automatically", and a narrow slice of this item shipped
(#3954): the review and fix-dispatch daemons merge `origin/main` into their clone before every tick and exit so
launchd relaunches them on the new code. The drain daemon does the same behind an opt-in, a primary-checkout guard
and a 5-minute restart floor. That is the *opposite* of what the first prep recommended for Forks 2 and 4, so this
re-prep frames them as **ratify what runs, and fix what it gets wrong** — not as a fresh choice. The skeptic found
three real defects in what runs: two daemons share one clone, so only the one that merged restarts; the merge form
lets the clone drift 54 commits off `main`; and nothing guards the operator's primary checkout in code. One new
fork appears: may a daemon run code that has not landed on `main` (the "POC mode" now in flight)? Recommended: yes,
but only as a per-clone opt-in behind a test gate, a rollback that lives outside the daemon, and a statute
amendment — and never in a clone whose daemons review, label or land PRs.

*Re-prepared 2026-09-23 evening (session reprep-3681), superseding the morning prep against `fcc756b2c`. Cites
read on `origin/main` `051f2fcb3` and on the live host (read-only). Report:
`we:reports/2026-09-23-daemon-lifecycle-staleness-reload-prep.md` — its evening addendum section holds this re-prep's
grounding; its earlier sections and the research topic
[/research/resident-daemon-staleness-and-reload/](/research/resident-daemon-staleness-and-reload/) still hold the
prior-art survey. Two Opus skeptic rounds and two fresh-context screens ran on this version; the body is what
survived them (Fork 1 dissolved, Fork 2 re-worded, Fork 4 gained a sub-fork, Fork 5 narrowed to a per-clone opt-in).*

## Ruling

Ratified 2026-09-23, about 7:45–8:00 PM ET, by the operator in session, on this re-prepared body (PR #2546). The
operator's own words, in order:

1. "3681 ratified"
2. "seems simpler all on prototype for now, no?"
3. "once we have merge into main, we will still want to be able to run fixes of a darmon live and switch back
   to main once it merges"
4. "yes" — to the live-overlay design recorded under Fork 5 below
5. "ratified" — confirming the ruling as amended by the overlay design

- **Fork 1 — DISSOLVED, as re-prepared:** reload is a clean exit at the safe point; launchd or the supervisor
  relaunches. Never `kickstart -k` mid-tick.
- **Fork 2 — RATIFIED as re-prepared, option (a):** any new commit counts. Stale = the input heads the process
  booted from (`origin/main`, plus each overlay head) have moved. Every daemon checks its own inputs every tick,
  whoever moved the clone. 5-minute restart floor on every daemon.
- **Fork 4 — RATIFIED as re-prepared, option (a):** the daemons move their clone automatically, under a coded
  refusal of the operator's primary checkout (plus a designated-clone check), a cross-daemon per-clone
  reader/writer lock, pinned state paths, and the restart floor.
- **Fork 4 sub-question (how the clone moves) — RATIFIED, option (y) rebuild:** each tick the tree is rebuilt
  fresh from `origin/main`, then each overlay merged in. Uncommitted changes, or local commits in none of the
  inputs, make the daemon refuse and alert. It never wipes them.
- **Fork 5 — RATIFIED, AMENDED by the operator to "live overlays"** (replacing the re-prep's single opt-in POC
  branch):
  - Every daemon clone tracks `main` plus an explicit list of overlay fix branches, in a per-clone state file
    under its pinned state root (not checked in, so adding or removing an overlay never waits on a PR).
  - Each tick it rebuilds its tree: `main`, then each overlay merged in.
  - Tests pass before new overlay code is picked up.
  - An overlay drops automatically once it is in `main`: `git cherry` shows only `-`, or its PR is merged or
    closed. With no overlays left, the daemon is plain `main`.
  - An overlay that no longer merges cleanly is dropped with an alert, never frozen.
  - Rollback = remove the overlay. The re-prep's outside trigger (crash loop or stalled heartbeat after a
    change) is kept, and its action is now removing that overlay.
  - Scope: **all daemons may run overlays, the review daemon included** — the operator's explicit choice over
    the re-prep's "never in a clone that reviews, labels or merges PRs". Carve-out: the drain daemon and the
    `merge-orphan-sweep` pass merge to `main`, so they stay `main`-only.
  - This supersedes the long-lived POC-branch approach for daemons (`lane/daemon-poc`, epic 3999) and
    amends #poc-branch-declared-delivery-mode clause 4(a); card 3992 was the vehicle for that amendment and
    resolves with this ruling.

**Left open (filed, not ruled):** the re-prep excluded review clones *because of*
#drain-daemon-self-hosting-boundary clause 3 (a daemon never approves its own daemon-code change). The operator
allowed overlays in the review daemon but did not say how clause 3 then applies to an overlay whose graduation
PR that daemon would review. No default was stated, so it is its own decision card, **4043**. Clause 3
stands unamended until then.

Codified as [#resident-daemon-reload-lifecycle](../docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle),
which also amends [#poc-branch-declared-delivery-mode](../docs/agent/platform-decisions.md#poc-branch-declared-delivery-mode)
clause 4(a).

**Follow-on build, as filed (all under #3383):** 4048 (primary/designated-clone refusal), 4050 (boot
input heads + per-tick check + 5-min floor), 4041 (per-clone reader/writer lock), 4052 (pinned state
root), 4044 (rebuild form; blocked by 4041), 4002 (re-scoped: the live-overlay core; blocked by
4044), 4046 (test gate before new overlay code; blocked by 4002), 4049 (drain and
`merge-orphan-sweep` stay `main`-only; blocked by 4002), 4045 (child-call timeouts + outside heartbeat
check), 4047 (outside rollback removes an overlay; blocked by 4002, 4045), 4051 (running revision
and overlays in the heartbeat; blocked by 4050), 4040 (restart via request file), 4042 (retire
`lane/daemon-poc`; blocked by 3998, 4002). Existing cards kept: 3998 (pass-daemon self-sync), #3952
(dead-pid lease reclaim, a prerequisite), and #3467, #3397, #3756, #3984 as the re-prep's "Follow-on build"
section describes. The re-prep's slice 4 (split `wev-review-daemon` so no PR-acting daemon shares a POC clone) is
narrowed by the amendment to moving `merge-orphan-sweep` out (4049).

## The ask (operator, epic #3383, 2026-09-14)

Mechanize how the system manages its own long-running daemons instead of each session finding staleness by ad
hoc investigation. Three linked asks: (1) start/stop/restart/health-check tooling; (2) automatic detection that a
daemon's running code is stale against its branch's HEAD; (3) a reload path that does not lose in-flight
agent/command state — *"if it can reload and reconnect agent and command it could work"*.

**Operator direction since the first prep (2026-09-23, verbatim — grounding, not a ruling):**

- "This has to happen automatically" — about daemon staleness.
- "no manual fixes, improve the daemon if needed"
- "I'd thought we would first fix the deamon in protoytpe to go quick and then graduat to main once perfect"
- "restart daemonn from lane as soon as the fix is ready"

## FOUND (grounding, re-read 2026-09-23 evening)

**What runs now.**

- **Shared self-sync helper: `we:scripts/lib/daemon-self-sync.mjs`** (#3954, then #2533 timeouts). Its header
  calls it "3954 (narrow slice of decision #3681)". `decideSelfSync` (`:39`) is pure: merge only when fetched,
  behind, on `main` and clean; every failed probe fails closed (`fetch-failed`, `count-failed`, `head-failed`,
  `status-failed`). `selfSyncCheckout` (`:66`) fetches `origin/main`, then runs a real `git merge` (not a
  fast-forward, because the clone usually carries extra commits) and runs `git merge --abort` on any failure.
  Every git call has a 60 s timeout. `withSelfSync` (`:97`) runs the sync before each tick; if *this process*
  merged commits, it calls `onRestart` instead of the tick. The helper has **no restart floor, no test gate, no
  rollback, and no lock** between processes sharing a clone. It tracks `main` only.
- **Who uses it.**
  - Review daemon (`we:skills-src/conveyor/review-daemon.mjs:301-308`) and fix-dispatch daemon
    (`we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:189`): **always on**, no flag, and **both in the
    same clone** `wev-review-daemon` (plus six pass-daemon watchers). `onRestart` releases the lease and calls
    `process.exit(0)`; launchd `KeepAlive` relaunches. Their only guards are "on `main`" and "clean tree". The
    operator's primary is safe today only by accident: it sits on a detached HEAD, so `symbolic-ref` fails and
    the helper skips (`head-failed`).
  - Dispatcher (`we:skills-src/conveyor/runner.mjs:589-593`, #2527 / #3984): **opt-in**. `wireSelfSyncAndAppAuth`
    wires self-sync only with the `--self-sync` flag (`:661`); there is no coded primary guard, only the flag. The
    flag is passed by `we:skills-src/conveyor/launchd/com.we.dispatcher.plist.example`, marked "STAGED, NOT
    INSTALLED", which also points at `wev-review-daemon`. No dispatcher launchd job is loaded.
  - Drain daemon (`plateau:tools/drain-daemon/`): **opt-in** (`DRAIN_DAEMON_SELF_SYNC=1` plus
    `DRAIN_DAEMON_SELF_SYNC_ROOT`, both set in its live plist). `decideSelfSyncAllowed`
    (`plateau:tools/drain-daemon/lib.mjs:86`) refuses when the checkout is the operator's primary. A **5-minute
    restart floor** (`minRestartIntervalSec: 300`, `plateau:tools/drain-daemon/lib.mjs:28`, plateau PR #183,
    merged 2026-09-23) defers a restart for a young process. It loads WE's helper at run time from its WE clone.
    It runs alone in the dedicated clone `plateau-drain-daemon`, so #2501 clause 1's dedicated clone is now built.
  - Pass-daemon watchers (`we:skills-src/conveyor/pass-daemon.mjs`) and the verify daemon: **no self-sync.** The
    six watchers in `wev-review-daemon` had been up about 5 h at 18:45 while that clone merged `main` 30+ times
    under them. **In flight, not landed:** a worker is adding self-sync to them plus a "POC mode": the clone
    follows a registered branch `lane/daemon-poc` and merges both `origin/main` and `origin/lane/daemon-poc`
    (env `DAEMON_SELF_SYNC_BRANCH`). `origin/lane/daemon-poc` exists but has no commits past `main`, and
    `DAEMON_SELF_SYNC_BRANCH` appears in no pushed commit yet.
- **Still unbuilt from the first prep:** no boot sha in any heartbeat or lease (`bootSha` appears nowhere);
  `classifyExit` (`we:skills-src/conveyor/supervisor.mjs:94`) has no `reload` reason, so an early exit is still
  `too-short` (`:97`); `DAEMON_MANIFEST` (`we:skills-src/conveyor/daemon-manifest.mjs`) lists pass scripts only,
  with no lifecycle fields and no drain entry; no daemon status/restart operation; the watchdog last-known-good pin
  is not on `main`.

**What happened today (evidence for the forks).**

1. **Self-sync restarts work — for the process that merged.** The `wev-review-daemon` reflog shows 33 self-sync
   `merge origin/main` entries between 10:28:03 (when the self-sync branch itself was merged in by hand) and 18:30, about four an hour, each
   between ticks. The logs repeat `daemon-self-sync: merged N new commit(s) from origin/main — restarting onto the
   new code`. The drain clone fast-forwarded at 14:06 and 14:52 with a matching restart line. No lost work was
   traced to these restarts. **But** each merge restarted only the daemon that made it: at 18:45 the fix-dispatch
   daemon had been up since about 18:10, while the clone moved at 18:21 and 18:30, so it was running code older
   than its checkout.
2. **Launch-from-lane shipped a hang.** At 18:20 an unreviewed lane commit (`38b8b0ab9`, PR #2542, still open)
   was merged by hand into `wev-review-daemon` so the daemons would run it early. It added a `git cherry` call
   per lane per remote head to `we:scripts/lane-pool.mjs` (O(lanes×heads)), which hung the fix daemon's WE tick
   for more than 5 minutes. It was reverted in the clone by hand at 18:40 (`fff012906`). A
   `we:scripts/lane-pool.mjs` `list` child started about 18:22 was still running at 18:45. Nothing detected the
   hang and nothing rolled it back. The reflog shows the same hand-merge habit earlier (08:25, 09:22, 09:30,
   17:51).
3. **A force-killed daemon blocks its own relaunch.** A SIGTERM mid-tick cannot run the shutdown handler (the
   tick is inside long synchronous `execFileSync` calls). `launchctl kickstart -k` then SIGKILLs it, the lease
   is never released, and every relaunch fails with "a live instance already holds the lease" until the TTL
   expires. Seen twice today; #3952 (open) proposes reclaiming a same-host lease whose pid is dead.
4. **`kickstart -k` mid-tick is the hazard** behind (3). This contradicts a premise in
   [#drain-daemon-self-hosting-boundary](/docs/agent/platform-decisions/#drain-daemon-self-hosting-boundary)
   clause 2, which calls `kickstart -k` redundant because "its SIGTERM runs the same clean handler". It does not
   while a tick is inside a synchronous call.
5. **The clone is not `main`.** `wev-review-daemon` sits 54 commits ahead of `origin/main` (hand merges of lane
   work, then self-sync merge commits). The daemons already run `main` plus unreviewed extras, with no record of
   which.
6. **State split still applies to the dispatcher.** The operator's queue is found by script location
   (`we:scripts/conveyor/queue-store.mjs:129`). The staged dispatcher plist runs from `wev-review-daemon`, so it
   would read that clone's `.conveyor/`, not the primary's
   ([#state-lives-where-its-nature-dictates](/docs/agent/platform-decisions/#state-lives-where-its-nature-dictates)).

**Unchanged from the first prep:** Node cannot unload modules; agents, leases and drain state live outside the
process; pass children spawn fresh code; nothing relaunches the conveyor supervisor. Statute:
#drain-daemon-self-hosting-boundary (#2501) — dedicated clone updated by `fetch` + `reset --hard origin/main` +
`clean -fdq` (clause 1), clean exit + `KeepAlive` between passes (clause 2), independent review of the daemon's own
source (clause 3). [#poc-branch-declared-delivery-mode](/docs/agent/platform-decisions/#poc-branch-declared-delivery-mode)
clause 4(a): "the runner's own steady state is still tracking `main` — a POC branch is a delivery TARGET … never
the default tracking ref"; clause 4(c): every POC branch needs a registry entry.

## Axis framing

Three live questions: **when** a daemon counts as stale (Fork 2), **who moves its clone and how** (Fork 4 and its
sub-fork), and **which code a daemon may run before `main` has it** (Fork 5, new). Forks 2 and 4 are *de facto*
decided by what runs and by the operator's "has to happen automatically"; for them the call is **ratify what
runs, or change it**, and each default names exactly what it changes. How a daemon reloads (old Fork 1) and when
it checks (old Fork 3) are now forced by the platform and by what runs — see Supported by default.

## Recommended path at a glance

| Fork | What runs today | Recommended default | Main alternative (excluded) | Confidence |
|---|---|---|---|---|
| ~~Fork 1 — reload primitive~~ | clean exit + `KeepAlive` | dissolved → Supported by default (forced: Node cannot hot-reload) | — | — |
| Fork 2 — what counts as stale | "I just merged" → that process restarts | **(a) any new commit, re-worded: stale = the clone's input heads (`main`, POC) moved since this process booted, checked by every daemon every tick; 5-min restart floor** (flipped from the first prep) | (b) loader-hook check of loaded files | high |
| ~~Fork 3 — what triggers the check~~ | check before each tick | dissolved → Supported by default | — | — |
| Fork 4 — who moves the clone | each daemon, racing in a shared clone | **(a) automatic, by the daemons, under a per-clone reader/writer lock, a coded primary guard and a fixed state root** (flipped from the first prep) | (b) detect-only, someone promotes | high |
| Fork 4 sub-fork — how the clone moves | `git merge` on top of whatever is there | **(y) rebuild: reset to `origin/main` (plus the registered POC head, if any) — #2501 clause 1's form** | (x) keep merging on top | med-high |
| Fork 5 — code not yet on `main` (new) | hand merges of lane commits; POC mode in flight | **(c) per-clone opt-in POC branch, off by default, never in a clone that reviews or lands PRs, behind a test gate and an outside rollback, with a statute amendment** | (b) ad hoc launch-from-lane | med |

## Supported by default (not forks)

- **Reload = exit cleanly at the safe point; launchd or the supervisor relaunches (was Fork 1).** Forced: Node ESM
  cannot unload modules, so in-place hot-reload leaves old timers, listeners and lease handles running old code.
  This is #2501 clause 2 and what the review, fix and drain daemons do today
  (`we:skills-src/conveyor/review-daemon.mjs:302-306`). A thin parent that runs each tick as a fresh child is a
  compatible build shape — it shrinks what can go stale — not a competing rule.
- **Check before each tick (was Fork 3).** What `withSelfSync` does. A file watcher buys nothing, since nothing
  acts before the safe point.
- **Restart means "exit at your next safe point".** Never `launchctl kickstart -k` a daemon mid-tick (incidents
  3–4). A `daemon restart <name>` operation drops a request file the daemon reads before its next tick. #3952's
  same-host dead-pid lease reclaim is a prerequisite, so a daemon that *was* killed hard still relaunches at once.
- **A `reload` exit reason in `classifyExit`,** checked before the `too-short` rule, for daemons the conveyor
  supervisor hosts. launchd-hosted daemons already treat exit 0 as a normal relaunch.
- **Publish the running revision** (the boot sha per repo, and the tracked heads) in the heartbeat or lease
  record, so `runner-activity` can say "running `abc`, clone at `def`".
- **One mechanism, per-daemon settings.** Every daemon uses `we:scripts/lib/daemon-self-sync.mjs`. Per-daemon
  data (clone, tracked branches, floor, relauncher, POC opt-in) goes on `DAEMON_MANIFEST`, extended with
  lifecycle fields and a read-only entry for the drain daemon — not a second registry.
- **Hang detection lives outside the tick.** A per-tick budget cannot fire inside a synchronous `execFileSync`
  (incident 2). So: a timeout on every child call the tick makes, plus an outside check that the heartbeat keeps
  moving. This is what would have caught incident 2 without a human.
- **Build prerequisites:** #3952 (dead-pid lease reclaim); `pass-daemon` kills its in-flight child on SIGTERM; a
  durable review claim; an outside relauncher for the conveyor supervisor.

## Fork 2 — what counts as stale

*Fork-existence:* real either/or — one rule decides when a daemon restarts. (b) needs a loader hook in every
daemon and still misses code read with `fs`; (a) restarts more. Only one can be the trigger. What runs today is
neither cleanly: it restarts only the process that did the merge.

- **(a) Any new commit — re-worded: stale = the inputs this process booted from have moved (default, flipped
  from the first prep).** At boot every daemon records, for each repo it loads code from (the drain loads WE's
  helper from a second clone), the input heads its clone was built from: the `origin/main` sha, plus the POC-branch
  sha if the clone has one (Fork 5). At every tick it compares them with the clone's current inputs, whoever moved
  the clone. Comparing *inputs*, not HEAD, matters: a rebuild that re-merges an unchanged POC head writes a new
  merge commit, and a HEAD check would then restart forever. *Pro:* the running code never lags its checkout, for
  every daemon in a shared clone (fixes incident 1's fix-daemon gap); restarts are between ticks with state
  outside the process, so each costs seconds. *Con:* about four restarts an hour per daemon at today's merge rate;
  the floor caps it.
- **(b) Restart only when a file the daemon loaded changed.** The first prep's default: a `module.register` hook
  records loaded files. *Pro:* about 10× fewer restarts. *Con:* a new boot-time piece in every daemon; misses
  files read with `fs`; needs an age backstop. Once the clone moves by itself (Fork 4), a missed file means the
  daemon silently runs old code next to new code.

**Default: (a) as re-worded, with a 5-minute restart floor on every daemon** (WE's helper gains the drain's
`minRestartIntervalSec`). The floor counts from process start, so it bounds self-sync restarts only; a crash loop
is bounded by launchd's `ThrottleInterval` (60 s in these plists) and the supervisor's crash backoff.

```js
// Fork 2 (a) — we:scripts/lib/daemon-self-sync.mjs withSelfSync, proposed
// BOOT_INPUTS, per repo the daemon loads code from: { main: '<origin/main sha>', poc: '<POC sha>' | null }
const BOOT_INPUTS = readCloneInputs(roots);                          // recorded once, at process start
tickOnce: async (...args) => {
  if (Date.now() - PROCESS_START_MS >= minRestartIntervalMs) {
    syncClonesIfInputsMoved({ roots, branches });                    // Fork 4: only the lock holder moves a clone
    if (!sameInputs(readCloneInputs(roots), BOOT_INPUTS)) return onRestart();
  }
  return tick(...args);
},
```

Skeptic: REFUTED as first worded ("any merge → restart"): in a shared clone only the merging daemon restarts and
the others keep old code (confirmed live: the fix daemon at 18:45). Re-worded to a per-process check; the second
round then showed a HEAD check would loop once a POC head is re-merged on every rebuild, and that the drain loads
code from two clones — so the check compares recorded input heads per repo. Also noted the floor does not cap
crash loops — stated above.
Screen: clear — whether a daemon can run code older than its checkout is operator-visible; with both free to
build, (b) can still run stale code and (a) cannot, so a merit difference remains.

## Fork 4 — who moves the clone a daemon runs from

*Fork-existence:* real either/or — for a given clone, either the daemons move it automatically or a separate
actor does after a report. The operator's "This has to happen automatically" and "no manual fixes" exclude the
branch that waits on a person; a mechanical promoter is just (a) under another name.

- **(a) Automatic, done by the daemons in the clone (default, flipped from the first prep).** Conditions every
  self-updating clone must meet:
  (i) **coded primary guard** — lift the drain's `decideSelfSyncAllowed` into WE's helper: refuse when the
  checkout is the operator's primary (compared after resolving symlinks), and require the clone to be the
  designated one. Ship the designated-root setting in the review, fix and dispatcher plists *before* the guard, or
  the guard silently turns self-sync off;
  (ii) **per-clone reader/writer lock** — each tick holds a shared hold on its clone; the mover takes an
  exclusive hold, so the tree never moves under a running tick or its children, and only one process moves it.
  The others see the inputs move and restart via Fork 2. Today two daemons can `git merge` in one tree at once,
  and a lock failure is treated as a conflict whose `merge --abort` can undo the other's merge;
  (iii) **state at a fixed root** — every file a daemon reads or writes that is found by script location moves to
  a root given by env or flag: the `.conveyor/` queue (FOUND 6) and the tracked
  `we:scripts/conveyor/run-scorecards.json` (`we:scripts/conveyor/run-scorecard-store.mjs:50`, committed locally by
  `we:scripts/review-set-label.mjs:491`). The dispatcher plist is not installed until this holds;
  (iv) **restart floor** (Fork 2).
- **(b) Detect-only: publish "origin is N ahead", a person promotes.** The first prep's default. *Con — excluded:*
  it is the manual step the operator ruled out; the helper's header records the clone re-synced by hand "5+ times
  on 2026-09-23 alone" before self-sync shipped.

**Default: (a).**

```js
// Fork 4 (a)(i) — the drain's guard (plateau:tools/drain-daemon/lib.mjs:86), lifted into the WE helper
export function decideSelfSyncAllowed({ root, primaryRoot, designatedRoot }) {
  if (realpath(root) === realpath(primaryRoot)) return { allowed: false, reason: 'primary checkout — never self-sync' };
  if (realpath(designatedRoot ?? '') !== realpath(root)) return { allowed: false, reason: 'not the designated daemon clone' };
  return { allowed: true };
}
```

**Fork 4 sub-fork — how the clone moves.** *Fork-existence:* the two forms cannot both hold — either the clone is
rebuilt to a known state or it accumulates.

- **(x) Keep merging on top — what runs today.** *Con:* the clone drifts (54 ahead, incident 5) and carries
  whatever anyone merged by hand, with no record; a rollback needs a reset anyway; and it contradicts #2501 clause
  1, so ratifying it means amending that clause, a principle-level change.
- **(y) Rebuild: `reset --hard origin/main`, then merge the registered POC head if the clone has one (default).**
  *Pro:* the clone is always a pure function of (`origin/main`, POC head); rollback is "reset to the last good
  pair"; hand merges cannot linger; matches #2501 clause 1. `clean` is safe once state lives at a fixed root
  (condition iii); until then, reset without `clean`. **Safety rule:** before any reset, refuse and alert if the
  tree is dirty or HEAD carries commits that are in neither input head — so an unpushed scorecard commit or a
  stray hand merge is surfaced, never silently wiped. *Con:* anything merged by hand is refused, then must go
  through a lane PR or the POC branch — which is the point ("no manual fixes").

**Default: (y).**

Skeptic: SURVIVES-WITH-AMENDMENT — the attack showed the shared clone needs one mover (added the lock), that the
guard would silently disable self-sync unless the plists gain the designated root first (added), that the primary
is protected only by its detached HEAD today (recorded in FOUND), and that the draft's "merge, never reset"
reversed #2501 clause 1 and fought Fork 5's rollback — so the sub-fork was added with rebuild as its default. The
second round attacked (y): a reset would wipe tracked runtime state (the scorecard file in condition iii) and
could move the tree under a mid-tick child; folded in as the refuse-if-dirty-or-foreign-commits rule, the
reader/writer lock, and condition (iii)'s wider scope.
Screen: clear (Fork 4 and its sub-fork, fresh re-screen) — whether a person must act, and whether the clone can
silently diverge from `main`, are operator-visible; neither is an effort call.

## Fork 5 — which code a daemon may run before `main` has it (new)

*Fork-existence:* real either/or at the statute level — either a daemon clone may track a POC branch at all, or
it may not. #poc-branch-declared-delivery-mode clause 4(a) says the runner's steady state tracks `main`, never a POC
branch; the operator wants daemon fixes to run "in protoytpe to go quick". (b) is broken (incident 2). Once POC
tracking is allowed, whether a given clone uses it is a per-clone setting, not a further fork.

- **(a) `main` only, everywhere.** Daemons run only merged, reviewed code; the in-flight POC mode is not wired.
  *Pro:* no statute change; no review hole. *Con:* against "first fix the deamon in protoytpe to go quick" and
  "restart daemonn from lane as soon as the fix is ready"; every daemon fix waits for full review and landing.
- **(b) Ad hoc launch-from-lane — what happened today.** Anyone merges a lane commit into a clone by hand.
  *Con — broken:* incident 2 — an unreviewed perf regression hung the fix daemon, nothing noticed, and the repair
  was a hand revert (against "no manual fixes").
- **(c) A per-clone opt-in POC branch, off by default, under conditions (default).** A clone may set
  `DAEMON_SELF_SYNC_BRANCH` to one registered POC branch (e.g. `lane/daemon-poc`, the in-flight build). Conditions:
  (1) **statute first** — amend clause 4(a) to allow a daemon clone, by explicit opt-in, to track `main` plus one
  registered POC branch, and give the branch its clause 4(c) registry entry;
  (2) **never in a clone that runs anything which reviews, labels, merges or lands PRs** — the review daemon, the
  drain daemon, and the `merge-orphan-sweep` pass (it runs `we:scripts/merge-ai-prs.mjs`). POC code there could
  review or land its own graduation PR (the #809 self-approval hole #2501 clause 3 closes). A POC-tracking daemon
  runs in its own clone; today's shared `wev-review-daemon` must be split first;
  (3) **test gate before the POC head is taken** — the daemon's own tests pass on the rebuilt tree in a scratch
  worktree before the live clone moves;
  (4) **rollback outside the daemon** — the relaunch wrapper (not the new code, which may crash at import) sees a
  crash loop or a stalled heartbeat after a move, rebuilds the clone at the last good (`main`, POC) pair, skips
  that POC head until it changes, and alerts;
  (5) **graduate by review** — POC commits reach `main` through the normal independent review.
  "Restart the daemon from a lane" becomes "push the fix to the clone's POC branch".

**Default: (c).** It gives the operator the fast path he asked for, keeps `main`-only as the default for every
clone, and closes each hole incident 2 exposed.

```js
// Fork 5 (c) — which heads a clone rebuilds from (Fork 4 sub-fork (y)); gate and rollback are build slice 3
const heads = ['origin/main', entry.pocBranch && `origin/${entry.pocBranch}`].filter(Boolean);
if (entry.pocBranch && cloneRunsPrActor(entry.clone)) throw new Error('POC tracking not allowed: this clone reviews, labels or lands PRs');
rebuildClone({ root, heads, gate: runDaemonTests });  // moves the live clone only if the gate passes
```

Skeptic: REFUTED the draft (c) as a plain default — it collided with clause 4(a), which the draft had cited as
support; it let POC code run in the review daemon (self-approval); and its rollback lived inside the new code and
reverted `main` commits along with POC ones. Rewritten as a per-clone opt-in with the statute amendment, the
review/drain exclusion, an outside rollback keyed on the (`main`, POC) pair, and rebuild instead of accumulated
merges. The attack's fallback was (a); (c) as rewritten keeps (a) as every clone's default. Second round:
SURVIVES-WITH-AMENDMENT — the exclusion was keyed on two roles and missed `merge-orphan-sweep`, which merges PRs;
now keyed on what the clone does, with that pass named.
Screen: flagged(impl) on the draft (it hard-coded a dry-tick timeout and pin mechanics in the ruling) → moved
those to build slice 3; the ruling now states only the policy. Re-screen (fresh): clear — whether unreviewed code
may run in a daemon, and where, is operator-visible.

## Statute note (for `codifiedIn` at resolve)

Mint `#resident-daemon-reload-lifecycle` covering Forks 2, 4 and 5 and the forced reload rule for every resident
daemon. How it composes:

- **#drain-daemon-self-hosting-boundary** — the drain is the worked instance. Clause 1's rebuild form is kept
  (Fork 4 sub-fork (y)). Clause 2's premise that `kickstart -k`'s SIGTERM "runs the same clean handler" is wrong
  during a synchronous tick (incidents 3–4); the new anchor records that correction. Clause 3's independence rule
  is why Fork 5 (c)(2) excludes any clone that reviews or lands PRs.
- **#poc-branch-declared-delivery-mode** — Fork 5 (c) *amends* clause 4(a) (a daemon clone may opt in to tracking
  one registered POC branch) and uses clause 4(c)'s registry. This is a principle-level change for the operator
  to ratify with Fork 5, not something a build may assume.
- **#state-lives-where-its-nature-dictates** — Fork 4 condition (iii).
- **#drain-daemon-self-hosting-boundary clause 1** (dedicated clone), not #primary-read-only-lanes-only, is the
  authority for Fork 4 condition (i); the latter governs agent edits and is only supporting context.

## Follow-on build (on ratification)

Re-scope the existing cards rather than duplicate them: #3467 and #3397 (runner and supervisor reload) adopt the
exit path and the `reload` reason; #3756 reads the published revision; #3952 lands as a prerequisite; #3984
(dispatcher daemon) waits for Fork 4 (i) and (iii) before its plist is installed. New slices:

1. WE helper: boot input heads + per-tick check, restart floor, reader/writer clone lock, primary/designated guard, rebuild form (Forks 2, 4) — `we:scripts/lib/daemon-self-sync.mjs`, plus the designated-root setting in the plist examples under `we:skills-src/conveyor/`.
2. Pass-daemon self-sync (the in-flight work), `main`-only until Fork 5's statute amendment lands — `we:skills-src/conveyor/pass-daemon.mjs`.
3. POC opt-in: test gate, outside rollback keyed on the (`main`, POC) pair, head skip — `we:scripts/lib/daemon-self-sync.mjs`, `we:skills-src/conveyor/`.
4. Split `wev-review-daemon` so the PR-acting daemons (review, fix, `merge-orphan-sweep`) never share a clone with a POC-tracking one (Fork 5 c 2) — plist examples under `we:skills-src/conveyor/`.
5. Child-call timeouts + an outside heartbeat check — `we:skills-src/conveyor/`.
6. Fixed state root for script-located state (`.conveyor/`, the scorecard file) — `we:scripts/conveyor/queue-store.mjs`, `we:scripts/conveyor/run-scorecard-store.mjs`.
7. Running revision in the heartbeat + `runner-activity` coverage from `DAEMON_MANIFEST` — `we:scripts/operations/runner-activity.mjs`.
8. `daemon restart` via a request file, no `kickstart -k` — `we:skills-src/conveyor/`.

Predicted touch-set: `we:scripts/lib/daemon-self-sync.mjs`, `we:skills-src/conveyor/`,
`we:scripts/conveyor/queue-store.mjs`, `we:scripts/conveyor/run-scorecard-store.mjs`, `we:scripts/operations/runner-activity.mjs`,
`plateau:tools/drain-daemon/`.

### Review jury (provisional — pre-registered #2638)

Care level: `elevated`. This jury binds against the item's predicted scope and is re-checked against the real diff at PR open.

| juror | lens | grounding method | pre-registered expectation |
| --- | --- | --- | --- |
| correctness#1 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. |
| security#1 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. |
| simplicity#1 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| standards-conformance#1 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| claim-accuracy#1 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |

## Done when

This is a decision item, not a build. Done when the operator rules on it via `/next decision`: for Forks 2 and 4
that means ratifying what runs with the named changes (or overriding them); for Fork 5, whether daemon clones may
track a POC branch and under which conditions. The build lands through the follow-on slices above.
