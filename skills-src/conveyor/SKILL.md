---
name: conveyor
description: Operate the conveyor from a live main session — start the singleton-locked headless runner that drives the mechanized tick (dispatch, watch, the deterministic cleanup passes) with no model context, and handle only the judgment it surfaces (readiness discussion, escalation review, ratifying, the operator conversation). Use when the operator wants to "run the conveyor", "start the conveyor", "keep delivering backlog items in the background", or operate the interim swimlane-progression loop (#2612). NOT for landing PRs (the resident drain daemon does that) and NOT for one item (that is /batch or a solo lane).
---

# Conveyor — main-session judgment layer over a headless runner (#2703, epic #2677/#2612)

The interim swimlane-progression loop. It has **two planes** since #2703 retired the main-session serial tick
loop:

- **The mechanical plane — a singleton-locked HEADLESS RUNNER** (`skills-src/conveyor/runner.mjs`, #2702). It
  drives the whole per-tick cycle — read state → plan the dispatch → step every guard/TTL/re-dispatch/watcher-arm
  /idle-stop decision through the tick core → run the deterministic cleanup passes — with **no model context per
  tick**. It **decides dispatch and watch**; it **never merges** and **never self-clears a human review**. It
  does not itself spawn LLM agents — it **surfaces** its already-filtered dispatch/watch decisions.
- **The judgment plane — THIS main session.** It **starts and supervises** the runner, then handles only the
  genuine judgment the runner can't: the readiness/operator conversation, clearing items for build, reviewing an
  escalation (`/review`), ratifying a prepared decision, surfacing a cleared epic for `/slice`, and — as the
  **interim bridge** until the headless agent-runner backend lands (below) — spawning, **on demand**, the LLM
  agents the runner surfaced. The chat stays a normal readiness conversation; the mechanical tick runs off in the
  runner.

This is the ratified **mechanics-not-per-lane-agent** split
([we:docs/agent/platform-decisions.md#conveyor-orchestration-mechanics-not-per-lane-agent](../../docs/agent/platform-decisions.md#conveyor-orchestration-mechanics-not-per-lane-agent),
#2701): driving one lane through dispatch → watch → release → tick is **pure deterministic mechanics stepped by a
headless runner**, not a per-lane LLM agent that re-derives the loop each tick. It runs now because the product
conveyor (the #2527 console board) is not built yet and one-story-at-a-time delivery is too slow.

> **The main session no longer runs the tick (#2703).** Before #2703 this main session *was* the tick loop — it
> chained a background `sleep`, shelled the state read + dispatch plan + tick core each beat, threaded the guard
> bookkeeping through its own context, ran the cleanup passes, and armed the watchers. **All of that is now the
> runner's job.** The main session **starts** the runner and then does judgment only. If you find yourself
> shelling `conveyor-state` / `dispatch-plan` / `tick-core` on a timer, threading `nextState`, or arming a
> `sleep` heartbeat from this session, that is the retired serial loop — stop; the runner owns it.

> **Interim bridge — the main session spawns the runner's surfaced agents ON DEMAND, until the headless backend
> lands (a DEGRADED interim, named honestly).** The runner spends no model context, so it **surfaces** (never
> spawns) the delivery / prepare / fix / CI-heal agents. Spawning an LLM agent needs a harness; the
> backend-agnostic **CLI agent-runner**
> ([we:docs/agent/platform-decisions.md#agent-runner-cli-backend](../../docs/agent/platform-decisions.md#agent-runner-cli-backend))
> that would let the runner spawn them itself, headlessly, is a **separate, later slice — not built in #2703**
> (whose scope is this doc only). So be clear-eyed about the interim: the runner drives the whole **mechanical**
> plane autonomously (state read, guards, the cleanup passes, the status line), but **automatic per-tick
> agent-spawning is not wired yet**, and neither is the reverse channel that would feed observed agent returns
> back into the runner's guards (`runner.mjs` folds no such signal today). Two consequences to state plainly:
>   - **Read the surface as structured JSON.** Launch the runner with `--json` (§2) so each tick prints the
>     already-filtered `{ dispatch: { builds, prepareScope, … }, armWatchers, notes, statusLine }` — the bare
>     runner prints only human counts, not the `{num, lane}` entries the judgment layer spawns from. The runner's
>     surface is the ONLY correct source of the guard-filtered launch list: an on-demand `dispatch-plan` /
>     `conveyor-state` read is UNFILTERED (it hasn't been through the in-flight guards, whose bookkeeping lives in
>     the runner's process, §5), and this session must not re-shell `tick-core` on a timer (that is the retired
>     serial loop).
>   - **The bridge is on-demand, not a chat loop.** A backgrounded runner notifies this session on its *exit*,
>     not per tick, so there is **no** automatic per-tick wake into the chat — reintroducing one would BE the
>     retired serial loop. Until the headless backend lands, the judgment layer reads the runner's latest surfaced
>     decisions and spawns the surfaced agents when it engages (an operator turn, a review, a completed agent's
>     return). This is **not** re-running the loop: the runner did all the planning, guard math, TTLs,
>     re-dispatch gating, and cleanup passes; the main session only *executes* the already-decided spawns and does
>     the genuine judgment. When the headless backend lands, agent-spawning (and the return-fold) moves into the
>     runner and this bridge retires.

> **THIN BY CONSTRUCTION — every decision with a right answer is a script call, per
> [we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment](../../docs/agent/platform-decisions.md#deterministic-core-thin-judgment)
> (#2607).** The judgment plane carries the **judgment only** — the readiness discussion, spawning a surfaced
> build, reviewing an escalation. It NEVER re-derives a dispatch plan, a state read, a watcher verdict, a guard,
> or an idle clock in prose: those are the runner's, decided by the tested scripts below. If a rule here reads as
> "compute X from the queue / leases / lanes", it is a bug — that computation belongs in the runner, in a script.

The runner and the scripts it (and the on-demand judgment surfaces) shell — do not reimplement any of them:

| Script | What it decides (deterministically) |
|---|---|
| `node skills-src/conveyor/runner.mjs` | **The singleton-locked HEADLESS RUNNER (#2702)** — the mechanical plane. The main session STARTS this (background); it then drives the whole per-tick cycle with **no model context**: it shells `tick-core` (bookkeeping in on STDIN, `{ decisions, nextState }` out), threads `nextState` forward UNCHANGED, runs the three deterministic passes (§4b/§4c/§4d), emits the status line, and **surfaces** the dispatch/watch decisions for the judgment layer to execute. Its singleton right is held by `runner-lock.mjs` (a machine-global TTL lease — a second launch that finds a LIVE runner stands down). It **never merges** and **never self-clears a human review**. |
| `node scripts/readiness/conveyor-state.mjs --json` | **The whole tick picture in one read** — `{ queue, clearedNotReady, unshaped, needsSlice, decisions, lanes, freeSlots, prs, daemon, idle, health, infraBlocked }`. The runner's every tick STARTS here (via `tick-core`); the judgment layer reads it on demand (status board, `/review` context). |
| `node scripts/conveyor/infra-blocked.mjs retry` | **The infra-blocked recovery pass (#2659)** — one idempotent resume pass: for each item whose lane ref was PUSHED but whose PR-open failed on an outside dependency (a GitHub outage), it correlates GitHub status, resume-opens the PR once infra recovers (via `pr-land` — never a local merge), backs off on failure, and surfaces at the attempt cap. |
| `node scripts/readiness/dispatch-plan.mjs --json` | **The dispatcher** — `{ launch: [{num, lane}], held: [{num, reason}] }`. Which cleared items launch into which free lanes, and why the rest hold. |
| `node scripts/conveyor/tick-core.mjs` (stdin ⇽ bookkeeping) <!-- @operation-home-ok: #3096 (born-as #xaibmeu) — the skill needs the WHOLE tick here, not just the dispatch slice `dispatch-lane` declares over; routing the spawnBuilds and spawnPrepareScope halves through the operation is its own item. Repointed 2026-08-26: this marker named #xbbscm5 (#3239), which is now resolved as a duplicate of #3096 along with #3147 — #3096 is the surviving card and carries both halves. --> | **The MECHANIZED tick core (#2699)** — the whole per-tick state machine in one call: it shells `conveyor-state` + `dispatch-plan` + the free-lane picker, takes your in-session guard/watcher bookkeeping on STDIN, and returns `{ decisions, nextState }`. `decisions` = `{ spawnBuilds, spawnPrepareScope, spawnPrepareDecision, spawnFixes, spawnCiHeals, armWatchers, retireGuards, idleStop, statusLine, notes }`; `nextState` = the next tick's bookkeeping. The FOUR guards (build, prepare, fix, CI-heal), their retirement (claim/return/TTL/PR-terminal/CI-recovery), the union re-dispatch gate, watcher arming, and idle-stop are all DECIDED here — you EXECUTE the decisions and carry `nextState` forward, you never re-derive a guard rule in prose. |
| `node scripts/conveyor/pr-watch.mjs <pr>` | **The merge watcher** — one background process per in-flight PR, now the OPTIONAL merge-time fast-path for lease release (§4); the runner is self-clocked, so this is no longer the loop's wake. Its exit CODE is the outcome (merged 0 · error 1 · parked 2 · timeout 3 · closed 4). |

> **Auto-prepare for unscoped items (#2613, corrected design — Nicolas, 2026-07-22).** Predicted `scope:` is
> authored UPSTREAM at readiness; the dispatcher only READS it — it never probes for scope at dispatch and
> **never launches an unscoped item to build.** An item that reaches dispatch with **no** `scope:` is held
> **`unshaped-no-scope`** ("no predicted scope — author it to parallelize") — **always**, even in a fully-idle
> pool with free lanes (building blind is exactly the hazard; there is **no** "serial floor" that runs it alone).
> Instead, the conveyor **auto-prepares** it: each tick, for every `unshaped-no-scope` held item (from the plan /
> `state.unshaped`), spawn ONE background **prepare-scope agent** (§3b) that predicts the item's touch-set and
> writes its `scope:` frontmatter as a one-file `ready-to-merge` PR. When that PR lands the item is scoped, and
> the dispatcher launches it to **BUILD** on a later tick. **So the flow is: unscoped cleared item → auto-prepare
> (add scope) → then build. The conveyor never builds without scope and never dispatches blind.** Scope is
> authored at readiness (here, just-in-time), not by the dispatcher
> ([we:docs/agent/platform-decisions.md#state-lives-where-its-nature-dictates](../../docs/agent/platform-decisions.md#state-lives-where-its-nature-dictates)
> — being codified in a sibling statute PR).

> **A cleared epic is a slice trigger, not a dead end (#2645).** An **epic** is a CONTAINER — its work lives in
> child stories/tasks, so it is **never directly buildable**. Before this rule a cleared epic fell into a silent
> hole: the dispatcher never launched it (an epic isn't agent-ready) and nothing routed it to slicing either. Now
> a cleared `kind:epic` is held **`needs-slice`** ("epic — /slice into buildable child stories") — a **first-class
> dispatch outcome**, checked BEFORE the scope gate so an (almost always scope-less) epic is **not** mislabeled
> `unshaped-no-scope` and auto-prepared (which would aim a build agent at a container). Each tick surfaces every
> such epic in `state.needsSlice` (each entry carries its `epicState`); handle them per §3d — **surface for
> `/slice`**, so a cleared epic always ends up either sliced-and-dispatched or explicitly awaiting slice, never
> silently stalled.

> **The conveyor drives DECISIONS too — prepare, then present (#2647).** A **decision** is NOT build work — its
> lifecycle is **prepare** (research + author its forks to "ready to ratify", the `/prepare` skill's autonomous
> half) then **present** (surface the prepared forks for a human to ratify). A decision carries no `scope:`, so —
> exactly like an epic — a cleared `kind:decision` is held **`needs-decision`** ("decision — prepare its forks,
> then present for ratify"), checked BEFORE the scope gate so it is **not** mislabeled `unshaped-no-scope` and
> aimed at a scope-prediction agent (which authors a build touch-set — meaningless for a decision). Each tick
> surfaces every cleared decision in `state.decisions` (each entry carries `prepared` + `preparedDate`); handle
> them per §3e — route by `prepared`: **UNPREPARED → spawn a prepare-decision agent** (autonomous research +
> fork authoring, lands a `preparedDate`); **PREPARED → present its forks** (a chat artefact + the #2565 ruling
> surface) for the human to ratify. Ratifying is human judgment — the conveyor prepares and presents, it never
> auto-ratifies. So a cleared decision always ends up either prepared-and-presented or explicitly awaiting
> ratification, never silently stalled — the conveyor drives the whole lifecycle: deliver + slice + decide.

The agent templates it instantiates: [`delivery-agent-brief.md`](delivery-agent-brief.md) (build a scoped
item, #2608), [`prepare-scope-agent-brief.md`](prepare-scope-agent-brief.md) (author an unscoped item's
`scope:`, #2613), [`prepare-decision-agent-brief.md`](prepare-decision-agent-brief.md) (prepare an unprepared
decision's forks to "ready to ratify", #2647), [`fix-agent-brief.md`](fix-agent-brief.md) (repair a
`review:changes` bounce in its own lane and re-arm review, #2630), and
[`fix-agent-ci-brief.md`](fix-agent-ci-brief.md) (rebase + repair a green-at-open PR gone red/BEHIND — CI only,
never the review label, #2666).

---

Manual intervention without a worker: `run.mjs why --pr=N|--item=X` then the op it suggests (see docs/agent/operator-ops.md).

## 1. Start / configure (a short conversation, then the loop)

Confirm three settings with the operator, then start ticking. Each has a default — a bare `/conveyor N` sets
the pool size to `N` and takes the defaults for the rest.

- **Pool size** — the max parallel lanes (the launch budget). Ensure the pool is provisioned to it:
  `node scripts/lane-pool.mjs provision --count=<N> --acquirable`. `freeSlots` in the state read is how many
  of those are currently free.
- **Per-program conflict policy** — what to do when a newly-queued item overlaps a running lane's scope:
  **wait** (default — hold it behind the lane, the dispatch plan already does this), **ask** (surface it and
  let the operator decide), or **force** (launch anyway — rarely wanted; two lanes on one path is a merge
  hazard). This only changes how you present a `held: "overlaps lane-N"` entry (§3); it never changes the plan.
- **Idle-stop window** — how long the queue stays empty with no operator feedback before the conveyor stops
  itself (default **15 min**).

State plainly to the operator, once, at start:

> **The chat stays conversational.** The conveyor runs in the background; ticks arrive on a timer and never
> block the chat. You steer it by talking here and by queuing work — to clear an item for the conveyor to
> pull, run:
> ```bash
> node scripts/conveyor/queue.mjs add <NNN>      # clear-for-build: the conveyor may now pull it
> node scripts/conveyor/queue.mjs remove <NNN>   # un-clear it (before it launches)
> node scripts/conveyor/queue.mjs list           # show what you've cleared this session
> ```
> The conveyor pulls **only** cleared items, in the build queue's ranked order. Re-prioritising the backlog
> never arms a build — clearing does. Type the id with or without a leading `#` (`add 2613` ≡ `add '#2613'`).
>
> **Clearing a not-yet-ready item is allowed but flagged.** If you clear an id that is not currently a ready
> build-queue row (blocked / resolved / typo), `add` still records it — a temporarily-blocked item auto-arms
> when its blocker lands — but it **warns** rather than silently doing nothing, and the tick's
> `state.clearedNotReady` (and a `held: 'cleared-but-not-ready'` in the dispatch plan) shows it so you always
> see "you cleared #X but it isn't ready". **JIT-numbering drift:** clear the id the tooling currently shows —
> a sidecar entry cleared as a `xHASH` won't match once the item lands as `#NNN` (and vice-versa); if a cleared
> id stops matching, `remove` it and re-`add` the current id.
>
> **The conveyor queue is SESSION-LOCAL** (#2613). `queue.mjs add/remove` writes a gitignored sidecar
> (`.conveyor/queue.json`) — it is NOT a card mutation (it never touches backlog frontmatter or
> `writeBacklogMd`), so it is **not** policed by the no-override lane guard and runs fine from THIS main
> session. That is deliberate: clearing an item for build is session-local operator intent, not committed repo
> state — so it must NOT go through `backlog.mjs build-queue add`, which writes `buildQueued:true` frontmatter
> and is BLOCKED from the primary checkout by the lane guard (#2302). Committed `buildQueued` frontmatter still
> exists (it feeds the `build-queue` view #2528/#2529 and the future product board), but it is a distinct,
> shared artifact from this session's conveyor queue — whether the two should reconcile is the open decision
> filed under #2612.
>
> **Which checkout you run this from no longer matters.** The queue is ONE machine-wide file in the
> automation's state home (`~/.claude/daemon-self-sync-state/conveyor-state/.conveyor/queue.json`), not a
> per-checkout sidecar, so every runner and daemon reads what you clear from any checkout
> (decouple-primary-checkout, epic #4075). `queue.mjs list` warns if it is still reading the OLD in-checkout
> file (run `queue.mjs migrate` once) or if an old-code writer is still clearing work into it.
> `node scripts/conveyor/queue-work.mjs add <NNN>` writes the same file but first refuses when no live runner
> is resolvable (no live runner, more than one, no pid recorded, the pid's working directory can't be derived,
> or the pid no longer looks like the runner).

Then start the headless runner (§2).

## 2. Start the runner — it IS the tick loop now (#2702/#2703)

**The main session does NOT run the tick.** It launches the singleton-locked headless runner as a background
process, and from then on the runner drives every beat with no model context. Start it once:

> **Operating it, not building it?** [`we:docs/agent/dispatcher-runbook.md`](../../docs/agent/dispatcher-runbook.md)
> covers liveness checks, safe stops, closing out a stuck `--bg` agent, and the env vars a real dispatch needs —
> this section is the interactive session's own operating script, not that reference.

```bash
node skills-src/conveyor/runner.mjs --json   # run_in_background: true — the mechanical plane's whole lifetime
```

`--json` makes each tick print its already-filtered surface as one JSON line
(`{ tick, statusLine, notes, dispatch: { builds, prepareScope, prepareDecision, fixes, ciHeals }, armWatchers }`)
— the structured record the judgment-layer bridge spawns from (§3). Without it the runner prints human count
lines only, with no `{num, lane}` entries to act on.

- **Singleton-locked — a second launch is safe and stands down.** `runner.mjs` acquires the machine-global
  runner lease (`runner-lock.mjs`) at startup; if a LIVE runner already holds it, the new launch NO-OPs (exit 0,
  "another conveyor runner holds the singleton lease; standing down"). So starting the conveyor when one is
  already running never double-drives — the lock is the cross-process guard the in-session dispatch guard can't
  see. The runner heartbeats the lease every tick and releases it at exit; a crashed runner's stale lease is
  reclaimable via the TTL, so a fresh `/conveyor` restarts cleanly.
- **The runner is self-clocked (no chained `sleep` from this session).** It sleeps ~120 s between ticks
  internally (just under the 5-min prompt-cache window — a legacy of the chained-sleep heartbeat this retired).
  It re-reads fresh state every tick, so it does **not** depend on a `pr-watch` exit or a `ScheduleWakeup` to
  advance. The old main-session chained-`sleep` heartbeat is **gone** (#2703).
- **The runner spends NO model context.** Every guard, TTL, re-dispatch gate, watcher-arm, and idle-stop is the
  tick core's; the runner threads the core's `nextState` forward unchanged and surfaces the decisions.

**What the runner does each tick — for reference (you do NOT run these; the runner does).** The steps below
DOCUMENT the mechanical tick the runner owns, so the semantics stay legible and the judgment layer knows what a
surfaced decision means. They are **not** a checklist for this session to execute on a timer.

1. **Read the whole picture (one call):** `node scripts/readiness/conveyor-state.mjs --json`
   → `{ queue, clearedNotReady, unshaped, needsSlice, decisions, lanes, freeSlots, prs, daemon, idle, health, infraBlocked }`.

2. **Plan the dispatch (one call):** `node scripts/readiness/dispatch-plan.mjs --json`
   → `{ launch: [{num, lane}], held: [{num, reason}] }`. THE dispatcher — the queue × active scope-leases ×
   free lanes decision. (It shells the same build-queue, scope-lease, and pool pickers under the hood, so its
   inputs match the state read above.)

2b. **Plan the whole tick (one call) — the MECHANIZED core decides every guard (#2699).** The runner shells
   `tick-core.mjs`, piping the previous tick's `nextState` (its process-ephemeral **bookkeeping** — `{ tick,
   buildGuards, prepareGuards, fixGuards, fixAttempts, ciHealGuards, ciHealAttempts, watched, launchedNums }`,
   plus `signals`, `{}` on the first tick) in on STDIN. `tick-core` re-shells the state read + dispatch plan +
   free-lane picker under the hood and returns `{ decisions: { spawnBuilds, spawnPrepareScope,
   spawnPrepareDecision, spawnFixes, spawnCiHeals, armWatchers, retireGuards, idleStop, statusLine, notes },
   nextState }`. The runner surfaces `decisions` and carries `nextState` into the next tick's STDIN **unchanged**
   — it never re-derives a guard, a TTL, a re-dispatch gate, or the idle clock. The guard sections further down
   DOCUMENT what the core encodes (so the semantics stay legible); they are not a second place to compute them.

   > **The bookkeeping is PROCESS-EPHEMERAL — it lives in the RUNNER's process, threaded through STDIN, never a
   > repo file (SKILL §5, memory rule 105).** It is which background jobs the runner surfaced, not item state; the
   > board stays the single truth. `tick-core` reads it in and returns the updated `nextState`, which the runner
   > threads into the next tick — so the whole guard/watcher ledger lives in the runner's memory, not this
   > session's, and no parallel on-disk store is ever created. (Before #2703 this ledger lived in the main
   > session's context; retiring the serial loop moved it into the runner.)

**What the JUDGMENT LAYER does with the surface.** The runner emits its per-tick `--json` surface (the status
line + the already-filtered `dispatch` / `armWatchers` decisions + the `notes`). Until the headless agent-runner
backend lands (intro bridge callout), the main session reads that surface and executes it **on demand** —
spawning each surfaced agent and handling each surfaced escalation per §3 below — when it engages, NOT on a
per-tick chat loop (there is no automatic per-tick wake; reintroducing one would be the retired serial loop). It
performs **no** guard math, TTL, or planning of its own — the runner already did all of it; the judgment layer
only spawns and judges.

3. **Spawn ONE background delivery agent per surfaced `decisions.spawnBuilds` entry.** The core has ALREADY filtered
   `plan.launch` through the *In-flight dispatch guard* (dropping any launch whose `num` **or** assigned `lane`
   is held by a still-pending spawned agent) and recorded the new guard entries in `nextState.buildGuards` — so
   you just spawn each `{num, lane}` it returns, no guard math of your own:
   - Resolve the item's spec path by **globbing `backlog/<num>-*.md`** (the plan returns only `{num, lane}`, not
     the slug), then read that file and its `scope:` frontmatter.
   - Instantiate [`delivery-agent-brief.md`](delivery-agent-brief.md) by substituting its placeholders:
     `{{ITEM_NUM}}`=`num`, `{{ITEM_SPEC_PATH}}`=the globbed `backlog/<num>-<slug>.md`, `{{LANE}}`=`lane`,
     `{{SESSION_SLUG}}`=`conveyor-<num>`, `{{SCOPE}}`=the item's `scope:` entries, repo-qualified and
     comma-joined (e.g. `we:scripts/conveyor,we:skills-src/conveyor`). Those five `{{DOUBLE_BRACE}}` tokens are
     the whole fill — the brief already names the real learnings drop-box command (`learnings-drop.mjs`) and
     every other step verbatim; do not rewrite its prose.
   - Spawn it as **one background `Agent`** with the filled brief as the prompt (default `run_in_background`).
     One agent = one item = one lane = one PR. The agent acquires its lane, claims the item, builds it, gets the
     gate green, then **runs an adversarial code-review subagent on its own diff and addresses the findings to
     convergence BEFORE opening the PR** (a green gate is not a review — #deterministic-core-thin-judgment: the
     gate is the deterministic core, the review is the judgment). Only then does it open the PR —
     `ready-to-merge` for a clean, reviewed, non-statute change, or parked `review:human` **only for good
     reason** (below) — and **exits without merging**.
   - **The guard entry is already recorded** — `tick-core` put `{ num, lane, spawnedTick }` for each spawn in
     `nextState.buildGuards` (see the guard below for what it encodes). You do not maintain it by hand.

3b. **Auto-prepare every unscoped held item — spawn ONE background prepare-scope agent per
   `decisions.spawnPrepareScope` entry.** The dispatcher NEVER launches an unscoped item to build; it holds it
   `unshaped-no-scope` and surfaces it in `state.unshaped`. `tick-core` has ALREADY applied the *prepare in-flight
   test* — the **union** re-dispatch gate: it skips any `num` for which EITHER a live prepare-guard entry exists
   OR `state.prs` has an **OPEN PR for that `num`** (while the item is still `unshaped-no-scope` it has **no** build
   PR, so any open PR for its `num` can only be its in-flight prepare — the backstop if the guard entry were lost)
   — and it has already **picked each prepare's lane** from the free lanes MINUS this tick's builds MINUS every
   guard-held lane (the same lane exclusion the build guard uses), recording the `{ num, kind:'prepare', lane }`
   entry in `nextState.prepareGuards`. So you just spawn each `{num, lane}` the core returns. Deciding to prepare
   vs to build is entirely the dispatch plan's classification the core reads (scoped → `spawnBuilds`; unscoped →
   `spawnPrepareScope`). Each prepare is **parallel-safe** with every build and every other prepare — its
   `--scope` is a single, distinct backlog file (`we:backlog/<num>-<slug>.md`), disjoint by construction. For each
   `{num, lane}` in `decisions.spawnPrepareScope`:
   - Resolve the item's spec path by **globbing `backlog/<num>-*.md`** (this is the ONLY file the prepare edits).
   - Instantiate [`prepare-scope-agent-brief.md`](prepare-scope-agent-brief.md) by substituting its four
     placeholders: `{{ITEM_NUM}}`=`num`, `{{ITEM_SPEC_PATH}}`=the globbed `backlog/<num>-<slug>.md`, `{{LANE}}`=the
     picked lane, `{{SESSION_SLUG}}`=`prepare-<num>`. Those four `{{DOUBLE_BRACE}}` tokens are the whole fill — do
     not rewrite the brief's prose.
   - Spawn it as **one background `Agent`** with the filled brief as the prompt. It acquires its lane, predicts the
     item's touch-set, writes `scope:` into the one backlog file, gets the gate green, then **runs an adversarial
     review subagent on its own scope prediction and addresses the findings to convergence BEFORE opening the
     PR** (the operator invariant #2629: no PR reaches a human review gate without a prior AI convergence pass —
     a scope PR can still be human-routed when statute-touching or sampled). Only then does it open a one-file
     `ready-to-merge` PR (auto-lands — no review escalation unless the item is statute-touching), then **exits
     without merging**. When that PR lands the item is scoped and dispatches to **build** on a later tick.
   - **The prepare-guard entry is already recorded** — `tick-core` put `{ num, kind: 'prepare', lane, spawnedTick,
     sawPr:false }` in `nextState.prepareGuards`, keyed by `num` (the contended resource is the item's scope
     authorship; the lane is carried only for this tick's exclusion). Its retirement is DIFFERENT from a build
     guard's and the core enforces it — see the prepare guard below. **Critically: a prepare Agent RETURNING does
     NOT retire its guard** (it returns at PR-open, mid-flight — several ticks before the PR merges); the core has
     no return path for a prepare guard at all.

4. **The watch is the runner's — it surfaces `decisions.armWatchers`, scoped to items THIS conveyor launched.**
   `state.prs` is built from `gh pr list` **repo-wide**, so it also carries PRs from other sessions / humans.
   `tick-core` has ALREADY filtered it to OPEN PRs whose `num` this conveyor dispatched this session
   (`nextState.launchedNums` — builds AND prepares), dropped the already-watched ones, and pruned the watched set
   to the currently-open conveyor PRs (`nextState.watched`). Each `decisions.armWatchers` entry is a
   `{ pr, releaseSession }` pair — the core already derived the `--release-session` slug (`conveyor-<num>` for a
   build PR, `prepare-<num>` / `prepare-decision-<num>` for a prepare PR). **The runner is self-clocked — it does
   NOT depend on a `pr-watch` exit to advance** (it re-reads fresh `state.prs` every tick and surfaces terminal
   PRs itself, §3). So a `pr-watch` process is now only the FAST-path for merge-time lease release, not the loop's
   wake; the judgment-layer bridge may spawn one per surfaced entry, but the runner's own per-tick **lease-reaper
   (§4c)** is the guaranteed backstop:
   ```bash
   node scripts/conveyor/pr-watch.mjs <pr> --release-session=<releaseSession>   # optional fast-path
   ```
   - **`--release-session` wires in the ghost-lease auto-release (#2667/#2700).** On a **merge** exit (and ONLY on
     merge — a park / close / timeout leaves the still-in-use lane held), pr-watch runs
     `lane-pool release --all-pools --session=<slug>`, which hands that item's lane lease back in EVERY pool it
     acquired AND resets the freed clone to origin/main. It is best-effort: a release hiccup never changes the
     merge outcome, because the runner's per-tick **lease-reaper (§4c)** is the catch-all backstop for anything it
     misses (a fix lease, a dead agent that never opened a PR, a merge that landed while nothing was watching).
   - **Prepare-scope PRs are watched the same way** (their `num` was dispatched this session too). When a prepare
     PR **merges**, the item now carries committed `scope:`, so the very next tick's `dispatch-plan` sees it as
     scoped and the runner surfaces it to **BUILD** — the auto-prepare → build handoff. The prepare PR reaching a
     terminal state (merged / closed / failed) is a prepare-guard RETIREMENT trigger (see the prepare guard
     below) — but the prepare **Agent returning is NOT**, because it returns at PR-open, several ticks before the
     PR lands.

4b. **The runner runs the infra-blocked recovery pass each tick — auto-retry/resume any pushed-but-unopened work
   (#2659).** A delivery or prepare agent that BUILT successfully and PUSHED its `lane/*` ref, but whose PR-open
   then failed on an OUTSIDE dependency (a GitHub partial outage, a network fault), returns `blocked-on-infra` —
   its built work is pushed and RECORDED, but no PR exists yet to watch. The runner runs ONE recovery pass per
   tick (`node scripts/conveyor/infra-blocked.mjs retry`) as a best-effort mechanical pass — the tick is the loop
   clock, so the pass does ONE round, no internal busy-loop. For each recorded item it correlates GitHub status (a
   real outage vs a one-off), and, once the backoff has elapsed, **resume-opens the PR from the recorded ref via
   `pr-land` — never a local merge** (the drain stays the sole writer to `main`, memory rule 104). On failure it
   backs off (exponential, capped); at the attempt cap it stops auto-retrying and **surfaces** the item for the
   operator. `state.infraBlocked` (and the ⊘ marker / collapsed **OUTAGE** banner on the status board) shows what
   is blocked and why — see §3f. `pr-land` records the block automatically at the failed open, so a
   conveyor-launched agent's `blocked-on-infra` return needs no extra bookkeeping.

4c. **The runner runs the lease-reaper each tick — the periodic ghost-lease backstop (#2667/#2700).** Merge-time
   auto-release (§4's `--release-session`) is the FAST path: it frees an item's lane the instant its PR merges.
   But it can't catch everything — a delivery agent that **died mid-build** (an API death) never opened a PR to
   merge, a **fix** lease (`fix-<num>`) rides a different session than the one the watcher releases, and a merge
   that landed while nothing was watching released nothing. So the runner runs ONE reaper pass per tick as the
   catch-all (`node scripts/conveyor/lease-reaper.mjs`; a gh-unavailable run degrades to the TTL-stale axis). It
   walks **every** lane pool and reclaims an orphan lease on any of its axes — the item's PR reached a terminal
   state (merged / closed, matched by head ref `lane/<num>-*`), or the lease outlived its TTL (the zero-IO
   dead-agent backstop) — delegating each reclamation to `lane-pool release --force` (so the reserved-memory-lane
   protection lives in ONE place; the reaper never rm's a marker itself). Like the §4b pass, the tick is the loop
   clock — one round per tick, no internal busy-loop. It is best-effort: a stuck lane is logged and skipped, and
   its exit never gates the tick. A freed lane is picked up by the very next tick's `dispatch-plan`.

4d. **The runner runs the session-reaper each tick — stops a `claude agents` background session once ITS OWN
   process reports it is finished (#3435).** A `claude agents` session registration is a wholly separate resource
   from a lane lease (§4c's own concern) — a finished review/fix/build dispatch stays LISTED (`claude agents
   --json`) until something calls `claude stop <id>` on it, and nothing did that mechanically before this pass:
   an operator had to run `claude stop <id>` by hand on every finished session, one at a time. So the runner runs
   ONE reap pass per tick (`node scripts/conveyor/session-reaper.mjs`), reading the same `claude agents --json`
   listing and calling `claude stop <id>` (via `dispatch-abort.mjs`'s existing `stopSession` wrapper — never a
   raw `kill`) on every `kind: 'background'` row whose `state` is `done` or `failed`. This is deliberately
   narrower than §4c's PR/TTL axes: it never touches a `working`/`blocked` row (still live, or merely not yet
   started) and never an `interactive` row (the operator's own open terminal) — the guard against ever touching a
   live session is structural, not inferred. Like §4b/§4c, one round per tick, best-effort (a stop failure is
   logged and skipped, never gates the tick).

5. **The runner emits `decisions.statusLine` and arms its OWN next tick.** The core builds the terse one-line
   status from the tick read + the live bookkeeping (counts of building / preparing / fixing / healing / queued /
   parked + the health verdict, with `· N infra-blocked` and a `⚠ lane-N` warn suffix appended when they apply)
   and gathers the per-tick surfaces in `decisions.notes` (a TTL re-dispatch warning, a `needs-slice` epic §3d, a
   prepared `decision-ready` §3e). The runner emits that line + notes each tick; if `decisions.idleStop` is true it
   STOPS itself (§6) instead of sleeping. **The main session does NOT arm a `sleep` heartbeat** — the runner is
   self-clocked (§2). The judgment layer surfaces the runner's status line / notes to the operator only when they
   carry something the operator must act on (a park to `/review`, an epic to `/slice`, a capped infra-block). Per
   the operator's progress-tracking preference the checklist is the channel and prose stays quiet — the runner's
   one line per tick reads, e.g.:
   > `conveyor · N building · N preparing · N fixing · N healing · N queued · N parked · health ok` — add
   > `· N infra-blocked` when `state.infraBlocked` is non-empty (pushed-but-unopened work the §4b pass is
   > auto-retrying; flag a capped/exhausted one for the operator) — where **`N preparing`**
   > is the count of prepare-scope agents in flight (auto-preparing unscoped items' scope), **`N fixing`** is
   > the count of fix agents in flight (repairing `review:changes` bounces, §3c), and **`N healing`** is the count
   > of CI-heal agents in flight (rebasing + repairing green-at-open PRs gone red/BEHIND, §3c-ci). Add `⚠` + the flagged lanes
   > when `state.health.verdict === 'warn'`; add `⚠ N auto-preparing scope: #A #B` when `state.unshaped` is
   > non-empty, so the operator sees those cleared items are being scoped now (a prepare agent per item) and will
   > build once their scope lands — see the auto-prepare callout above.
   The runner then sleeps ~120 s (just under the 5-min prompt-cache window) and steps the next tick. That
   self-clocked sleep REPLACES the retired main-session chained-`sleep` heartbeat (#2703) — the main session arms
   nothing.

> **On-demand board — the fuller status view.** The runner's per-tick line is the routine channel. When the
> operator asks "status" (or you want a fuller look on a slower beat), print the compact text board instead:
> ```bash
> node scripts/conveyor/status-board.mjs
> ```
> It is a pure text mirror of the plateau lane board that renders THIS same tick read
> (`conveyor-state.mjs --json`, env-inherited so `CONVEYOR_QUEUE_FILE` still points at the session sidecar) —
> a header count line plus **RUNNING** (each active lane + its state marker), **QUEUE** (each cleared item and
> WHY it waits), and **NEEDS YOU** (parked PRs with their `/review N` action). It invents no state and makes no
> decision; it only formats the read. Keep the runner's terse tick line as the routine channel and reach for the
> board on demand — do not replace one with the other.

> **On-demand jury tree — what the review jury is/does/found (#2641).** When the operator asks "what is the jury
> doing?" (or you want to see WHY a parked PR is being held), print the live jury tree:
> ```bash
> node scripts/conveyor/jury-tree.mjs            # every logged subject
> node scripts/conveyor/jury-tree.mjs --subject=we#123   # one PR
> ```
> It renders a `/workflows`-style tree per review subject — the roster, each juror's charter, its derived status
> (◷ pending · ⟳ running · ✓ found), its findings, its verdict, and the round — by folding the **durable
> append-only jury log** the review-pipeline writes (`.conveyor/jury/<subject>.jsonl`). It calls the ONE shared
> fold in `we:scripts/lib/jury-ledger.mjs` (the SAME fold the #2642 plateau-app console reads — never a second
> copy) and only formats the result; it is the #2612 single source of truth for the jury, not a parallel store.
> An idle conveyor with no logged jury run prints one honest note.

> **The three guard blocks below DOCUMENT what `tick-core.mjs` (#2699) encodes — they are not a second place to
> compute a guard.** The mechanized core (step 2b) applies every rule here and returns the filtered spawns +
> `nextState`; these blocks stay so the semantics remain legible and reviewable. If you find yourself re-deriving
> a TTL, a re-dispatch gate, or a retirement rule in prose, that is the bug #2699 closes — read the core's answer
> (`decisions` / `nextState`) and execute it. The pure functions and their unit proofs live in
> `scripts/conveyor/tick-core.mjs` + `scripts/conveyor/__tests__/tick-core.test.mjs`.

**In-flight dispatch guard (the one bit of ephemeral bookkeeping — held in the runner's process, #2703).**
Between a delivery agent being surfaced/spawned and that agent acquiring its lane + claiming the item, the item
is still in the queue and its lane still reads free — so a naive next tick could double-dispatch it. The core
keeps a list of guard entries (threaded through the runner's `nextState`, one per spawned agent):
`{ num, lane, spawnedTick }`. On each tick it **filters `plan.launch`** (`filterLaunches`) to drop any
entry whose `num` **OR** whose assigned `lane` matches a live guard entry — the contended resource is the LANE,
not just the item, so both must be excluded (else tick N launches `{num:100, lane:4}`, 100 is slow to acquire,
and tick N+1 re-assigns lane 4 to a different top-of-queue `num` while agent A is still starting — two agents
targeting lane 4).

**The prepare guard is DIFFERENT bookkeeping — do not copy the build guard's retirement.** A prepare-scope agent
(§3b) gets a `{ num, kind: 'prepare', spawnedTick }` entry, keyed by `num` (the contended resource is the item's
scope authorship, not the incidental lane). But a prepare is fundamentally unlike a build: **a build claims and
leaves the queue within a tick or two; a prepare NEVER claims and leaves the queue only at MERGE** — its item
stays `unshaped-no-scope` / in `state.unshaped` for every tick from spawn until its scope PR lands (CI + drain
latency, several ticks). And its Agent returns at **PR-open**, well before merge. So the build guard's "retire on
Agent-return" rule is a **double-dispatch bug** for a prepare (it would clear the guard while the item is still
unscoped, and step 3b would spawn a second, third, … prepare each tick until merge — competing same-file PRs on
burned lanes). The prepare guard therefore has its OWN rules:

- **Re-dispatch gate (the union, restated).** Skip spawning a prepare for `num` when EITHER a live prepare-guard
  entry exists for it OR `state.prs` has an OPEN PR for that `num` (which, while the item is still unscoped, can
  only be its prepare — it has no build PR). The open-PR clause is the backstop if the guard is ever lost.
- **Retire a prepare-guard entry ONLY on one of these — NEVER on mere Agent-return:**
  1. **Scope committed** — the item has left `state.unshaped` (the dispatch plan no longer holds it
     `unshaped-no-scope`, i.e. it now carries committed `scope:`). This is the success path; the item will build.
  2. **Prepare PR terminal** — the prepare PR for that `num` reached a terminal state (merged / closed / failed),
     surfaced by its watcher exit or by leaving the OPEN set in `state.prs`.
- **TTL is spawn-to-FIRST-PR only, not spawn-to-merge.** Do NOT inherit the build guard's 3-tick TTL — a healthy
  prepare's spawn→merge span is longer than that, and re-dispatching a slow-but-live prepare is the very bug this
  fixes. The prepare TTL fires for ONE purpose: to catch a prepare Agent that **died before opening its PR**. So:
  if NO open PR for `num` has appeared in `state.prs` within **N ticks (default 5)** of the spawn, assume the
  agent died pre-PR → drop the guard and allow re-dispatch (surface a one-line note). **Once an open prepare PR
  exists for the `num`, the TTL is void** — retirement is PR-terminal (rule 2) and a second prepare is already
  blocked by the open-PR clause, so a slow-landing but healthy prepare is never re-dispatched.

**Retire a BUILD/delivery guard entry three ways** (these are the delivery-guard's rules — a prepare guard uses
its own, above, and in particular does NOT retire on Agent-return):

1. **Claimed → the agent got going.** When the item shows as claimed in `conveyor-state` — its lane appears in
   `state.lanes` (leased) or it has left `state.queue` — drop the entry. This is the normal path, and in the
   headless-runner model (#2703) it is the LOAD-BEARING one: the runner reads it off each tick's fresh state.
2. **Agent completed / errored** — when the delivery `Agent` returns (any result, including an escalation),
   drop its entry. **Note (#2703):** this return-fold requires observing an agent's completion. The headless
   runner spawns no LLM agents (it surfaces them; the bridge spawns), so it observes no return and folds no such
   signal today — build guards retire via the CLAIMED path (1) and the TTL backstop (3). When the headless
   agent-runner backend lands and the runner spawns agents itself, its observed returns feed this path.
3. **TTL EXPIRY (the required backstop).** If an entry is still pending after **N ticks (default 3, ≈ 6 min)**
   without ever showing as claimed, **DROP it and let it re-dispatch**, and surface a one-line note the first
   time (`⚠ #<num> never claimed after <N> ticks — re-dispatching`). This covers an agent that **died after
   spawn but before claiming** (a crash during `acquire`/`npm`, a lost background task, a lost lane race): path
   (1) never fires, and the health/stall scan (now live — below) still can't see this window either, because a
   lane isn't leased or lane→num-mapped until the agent *acquires*, so a die-before-acquire lane never reaches
   `state.lanes` for the scan to flag. Without the TTL the `num` would sit guarded **forever** and that one item
   would silently stop delivering for the whole session. (Once the agent *does* acquire, this guard retires
   `claimed`; a stall AFTER that point is the reaper's + the operator's to reclaim, not this guard's — see below.)

> **`state.health` is LIVE now — it is a real backstop, no longer inert (#2616/#2700).** `lane-pool acquire
> --item=<num>` populates the lane→num map (`.claude/lane-ports.json`) that `conveyor-state`'s stall scan keys on,
> so the scan flags a genuinely stalled lane (a leased lane whose delivery-agent transcript has gone silent past
> the threshold) and `state.health.verdict` reads `warn`. `tick-core` CONSUMES that verdict: the status line shows
> the `⚠ lane-N` warn and each stalled lane becomes a `lane-stalled` note, and the **per-tick lease-reaper (§4c)**
> reclaims the stalled lane's lease on its TTL-stale axis. So health SURFACES the stall and the reaper RECLAIMS it
> — that is the backstop. **What it does NOT do is auto-re-dispatch a guard on a stall:** the stall threshold
> (≈3 min) is far shorter than a guard's spawn-to-death TTL, so treating a stall as a re-dispatch trigger would
> false-positive on a legitimately-quiet but live agent. The guard **TTLs (build rule 3, prepare TTL-to-first-PR,
> fix TTL) stay the re-dispatch backstop** — health informs the reclaim + the operator, it never overrides them.

This is process bookkeeping — which agents the runner surfaced — not a state store: the board stays the single
truth (see *State*).

## 3. How PR outcomes are handled — the runner surfaces, judgment stays main-session

The runner is self-clocked (§2), so it does NOT wait on a `pr-watch` exit to advance — it re-reads fresh
`state.prs` every tick and classifies each conveyor-launched PR's outcome itself, surfacing the ones that need
action. (An optional `pr-watch` fast-path, §4, still gives a snappier merge-time lease release, and `pr-watch`
exit codes carry the SAME contract — `0` merged · `2` parked · `4` closed · `3` timeout · `1` error.) Branch on
the outcome — do not re-derive the verdict; the runner/watcher already classified the PR:

- **merged (watcher `0`)** — the resident drain landed it; the lane is now free (auto-release / the reaper freed
  the lease). It drops from the watched set; the next tick's `dispatch-plan` fills the freed lane. Nothing else.
- **parked (watcher `2`)** — the PR carries a review label. **Which label decides the branch** (`pr-watch` exits
  `2` for all three; the runner reads the label off the fresh `state.prs` row — or `gh pr view <N> --json
  labels` — to tell them apart, #2630):
  - **`review:changes`** — a human bounced this diff and asked for a fix. The runner surfaces `spawnFixes` and
    the bridge **re-dispatches a fix agent into the PR's lane** (§3c below) — this is NOT just surfaced to the
    operator. The repair is script-shaped (reuse the ref, apply the finding, re-push, re-arm review); the fix
    agent does it and hands the PR back `review:pending`. The runner **never** self-clears the review label.
  - **`review:human` / `review:pending`** — an independent human verdict is owed. The runner surfaces it as a
    note; the judgment layer surfaces in chat: **"PR #N
    (#`<num>`) needs review — run `/review N`."** Do **NOT** auto-land it and do **NOT** auto-fix it: a human
    review park is a hard human-only gate. The lane stays held until the review resolves.

  Either way the PR stays OPEN, so the runner keeps surfacing it each tick — a re-armed `review:pending` (after a
  fix) or a fresh human bounce is re-classified on the next tick's state read.
- **closed (watcher `4`)** — the PR was closed without merging (a human abandoned it). The runner surfaces it as
  an **anomaly to investigate** — do NOT run `/review` (a label swap can't land a closed PR). Note the stranded
  lane (the reaper reclaims its lease off the terminal-state axis).
- **timeout (watcher `3`)** — the fast-path watcher's wall-clock budget elapsed with the PR still pending; the
  runner keeps re-reading it each tick regardless. Flag a possibly-stuck lane for the operator if it persists.
- **error (watcher `1`)** — bad arguments / the watcher couldn't run. Report it; a correct fast-path watcher can
  be re-spawned, but the runner's per-tick state read still covers the PR.

### 3c. Auto-re-dispatch a `review:changes` bounce — spawn ONE fix agent into the PR's lane (#2630)

When exit `2` resolves to **`review:changes`** on a PR **this conveyor launched**, a human bounced the diff and
asked for a change. Before #2630 that only parked and a human had to `/finish` it; now the conveyor re-dispatches
a **fix agent** to repair it in the same lane — **UNLESS** the *fix in-flight test* or the *retry cap* suppresses
it (both below). When neither suppresses:

- **Resolve the PR's lane ref and item.** From `state.prs` you have `{ num, prNumber }`; read the head ref with
  `gh pr view <prNumber> --json headRefName` → `lane/<num>-<slug>`. Glob `backlog/<num>-*.md` for the spec path
  and read its `scope:`.
- **Pick a free lane** the same way step 3 does (a `freeSlots` lane minus this tick's builds/prepares/guards) —
  the fix runs in a FRESH clone reset to the pushed lane ref (`acquire --base=<headRef>`), not the original
  lease, so it needs its own free lane.
- **Instantiate [`fix-agent-brief.md`](fix-agent-brief.md)** by substituting its placeholders: `{{ITEM_NUM}}`=`num`,
  `{{PR_NUM}}`=`prNumber`, `{{LANE_REF}}`=the head ref, `{{LANE}}`=the picked lane, `{{SESSION_SLUG}}`=`fix-<num>`,
  `{{SCOPE}}`=the item's `scope:` entries repo-qualified and comma-joined. Those six `{{DOUBLE_BRACE}}` tokens are
  the whole fill — do not rewrite the brief's prose.
- **Spawn it as ONE background `Agent`.** It acquires a lane on the pushed ref, reads the reviewer's finding off
  the PR, applies ONLY that fix, gets the gate green, re-pushes HEAD to the same `lane/*` ref, then **re-arms the
  review** (`review:changes → review:pending` via `scripts/conveyor/rearm-review.mjs`) and exits. It **NEVER**
  self-clears the human review label — the human (or the drain's AI-review convergence pass) re-verdicts the
  re-armed PR.
- **Record a fix-guard entry** `{ pr: prNumber, num, lane, spawnedTick, claimed: false }` — UNCLAIMED. **Do NOT
  bump the per-PR attempt counter here** (#3454 — bumping the instant a spawn is merely PLANNED, before
  `dispatch-lane.mjs`'s own in-flight guard has actually run, counted a dispatch that guard went on to refuse
  pre-flight — e.g. a stale `claude agents` liveness entry — as a real bounce; PR #1861 hit "auto-fix exhausted"
  after exactly two such phantom spawns and zero real dispatches). The counter bumps exactly once, LATER, the
  tick the guard's lane is actually observed leased in `state.lanes` (the same CLAIMED fact the build guard's own
  retirement already uses) — that is the mechanized core's job (`tick-core.mjs`'s `planTick`, off
  `retireFixGuards`'s `newlyClaimed`), not a step you perform here. The within-session tally and the counter's
  durable source of truth (the PR's own re-arm comments) are DISTINCT state — see the fix guard below. The spawned
  fix agent posts the durable re-arm comment when it re-arms, which is what the count reads back after a restart.
  The PR stays OPEN, so step 4 keeps a watcher on it — when the fix re-arms it to `review:pending`, that exit `2` routes to
  the `review:human`/`review:pending` branch (surface for `/review`), not back into auto-fix.

**The fix guard — its own bookkeeping, and TWO separate pieces of state (do NOT copy the build/prepare guard's
retirement, and do NOT conflate the two).** A fix dispatch tracks:

1. **An in-flight guard entry** `{ pr, num, spawnedTick }` keyed by the **PR number** — "a fix agent for this PR
   is live right now." It is retired (see below) the moment the PR is no longer awaiting an in-flight repair.
2. **A per-PR attempt counter** — "how many auto-fixes this PR has cost in total." It is a SEPARATE longer-lived
   tally that **survives the guard-entry retirement**. Keeping it off the guard entry is the whole point: a human
   bounce → fix → re-arm → human bounces AGAIN is a NEW `review:changes` with NO live guard entry, so if the count
   lived on the entry it would reset to 1 each cycle and the cap below would never bind. The counter must persist
   across fix↔bounce cycles or the loop is unbounded.
   **The DURABLE count derives from the PR itself, not from in-session memory (#2643).** Each completed auto-fix
   posts exactly one re-arm comment (`rearm-review.mjs`, marker `🔧 conveyor fix — re-armed for re-review`), so
   the count is **`countRearmComments(pr.comments)`** — read back off the PR's own comment thread. This is the
   restart-surviving source of truth: a session-side `fixAttempts[pr]` map would start EMPTY on a fresh / restarted
   conveyor, and the next bounce would auto-fix from zero — the cap would never bind (the exact unbounded fix↔bounce
   loop it exists to prevent, and a parallel state store §5 forbids). The mechanized guard binds the cap on
   **`max(in-session tally, durable re-arm count)`**: the durable count is authoritative and restart-surviving; the
   in-session tally is a within-session overlay that ALSO catches a fix agent that **died before re-arming** (it
   posts no comment, so the durable floor can't see it — but the TTL-backstop case must still terminate at the
   human). The tally clears on PR-terminal, and the durable comments become moot once the PR leaves the open set.

Its rules — two suppressions and one cap:

- **Fix in-flight test (skip re-dispatch).** Skip spawning a fix for a PR when a live guard ENTRY (piece 1)
  already exists for it. This is essential: right after you spawn the fix agent, step 4 re-arms a watcher on the
  still-`review:changes` PR (the agent hasn't re-armed yet), so the watcher exits `2` again almost immediately —
  the entry is what stops that second exit-2 from spawning a duplicate fix on a second burned lane.
- **Retry cap (default 3 auto-fix attempts per PR).** BEFORE spawning, check the attempt count (piece 2) —
  `max(in-session tally, countRearmComments(pr.comments))`. Once it has reached **3**, **stop auto-fixing** this PR
  and surface it for `/review` instead (`⚠ PR #N (#<num>) bounced <k>× — auto-fix exhausted, run /review N`).
  Because the count persists across cycles AND survives a restart (it derives from the PR's durable re-arm
  comments), this binds even when each cycle is a fresh human bounce with no live entry, and even when a restart
  wiped the in-session tally — a finding the auto-fixer can't satisfy in a few passes needs a human; never loop a
  fix↔bounce cycle unboundedly.
- **Retire the in-flight guard ENTRY (piece 1) two ways — NOT the attempt counter:** (1) **Re-armed / resolved**
  — a fresh `state.prs` read shows the PR no longer carries `review:changes` (it re-armed to `review:pending`, or
  merged/closed). Drop the ENTRY; **leave `fixAttempts[pr]` intact** (it only clears on PR-terminal). (2) **TTL
  backstop** — if the PR is STILL `review:changes` after **N ticks (default 5)** of the spawn, drop the ENTRY and
  allow a re-dispatch, on TWO different footings depending on whether it was ever `claimed` (#3454): a guard whose
  lane was NEVER observed leased in `state.lanes` — `dispatch-lane.mjs`'s own in-flight guard refused it
  pre-flight, or it died before ever acquiring one — retires **`ttl-unclaimed`**: no real attempt ever happened,
  so **nothing was bumped and nothing needs to be un-bumped**; it is simply retried for free next tick, mirroring
  the build guard's own "never claimed after N ticks — re-dispatching" backstop. A guard whose lane WAS observed
  leased at some point (the fix agent genuinely started, then went silent — died before re-pushing/re-arming)
  retires **`ttl`**: a REAL, if failed, attempt — already bumped at claim time, so it is still gated by the retry
  cap on re-dispatch (the counter did NOT reset), and a repeatedly-dying fix still terminates at the human. Clear
  `fixAttempts[pr]` only when the PR reaches a terminal state (merged / closed).

> **Red gate / red CI is NOT watcher-visible AT OPEN.** `pr-watch` reads only `state,mergedAt,labels`, so a
> gate-red or born-red PR reads as `pending`. A build that is red AT OPEN surfaces via the **delivery / fix agent's
> one-line return** (the #2608 / #2630 briefs), not the watcher — when a delivery or fix `Agent` completes with
> `… gate-red` / `fix escalated <reason>` / `escalated <label>`, surface that in chat. But a PR that was **green at
> open and went red LATER** is a different case the watcher also can't see — that is what §3c-ci auto-heals off the
> tick's state read (`state.prs[].ci`), not the watcher. (A fix agent that hits a red gate or an ambiguous finding
> leaves the PR `review:changes` and does NOT re-arm — so it re-enters the fix path on a later tick unless the
> retry cap has been reached.)

### 3c-ci. Auto-heal a green-at-open PR gone RED / BEHIND — spawn ONE CI-heal agent into the PR's lane (#2666)

§3c repairs a PR a **human** bounced (`review:changes`). This rule repairs a PR **CI** broke: a conveyor PR that
was **green at pr-land** but has since gone **red on a required check** (`state.prs[].ci === 'fail'`) or **BEHIND +
parked**. The dominant cause is `main` advancing under the branch — a sibling scope PR lands, the branch falls
BEHIND, and its `test` job breaks against the new main (a flake is the other cause). Nothing else heals it: the
**delivery agent has long exited** (one agent = one item = one PR), and the **drain skips a red-CI PR**. #2183
rebuilds a BEHIND but **landable** PR, but a PR **parked** `review:human` / `review:pending` is NOT landable, so
#2183 never fires for it. So the conveyor auto-dispatches a **CI-heal agent** — the CI-axis SIBLING of the §3c fix
agent — **UNLESS** the *in-flight test* or the *retry cap* suppresses it. The mechanized tick decides all of this;
you EXECUTE `decisions.spawnCiHeals`.

- **The trigger — a CI regression, not a label** ({@link tick-core.mjs `isCiHealTarget`}). An OPEN
  conveyor-launched PR (`num` ∈ `launchedNums`) that was **green at open** (carries `ready-to-merge` or a review
  park) and is now either **red-CI** (`ci === 'fail'`) or **BEHIND + review-parked** (the not-landable case #2183
  leaves; a BEHIND-but-landable PR is left to #2183). A **`review:changes`** PR is EXCLUDED — the §3c fix loop owns
  it and already rebases. A PR that was **never green** (no such label — a born-red build the delivery agent
  escalated) is EXCLUDED, so this never double-handles a gate-red escalation.
- **What the CI-heal agent does — repair ONLY CI, never the review label.** Instantiate
  [`fix-agent-ci-brief.md`](fix-agent-ci-brief.md) — substitute `{{ITEM_NUM}}`=`num`, `{{PR_NUM}}`=`prNumber`,
  `{{LANE_REF}}`=the head ref, `{{LANE}}`=the picked lane, `{{SESSION_SLUG}}`=`ci-heal-<num>`, `{{SCOPE}}`=the
  item's `scope:`, `{{REASON}}`=`red-ci`/`behind` — and spawn it as ONE background `Agent`. It acquires a lane on
  the pushed ref, **rebases onto current `main`**, diagnoses + repairs the failing check, re-pushes HEAD to the
  same `lane/*` ref, then posts a **durable CI-heal comment** (`scripts/conveyor/ci-heal-mark.mjs`) and exits. It
  **NEVER** touches `review:human` / `review:pending` / `review:changes` / `ready-to-merge` — **only CI is
  repaired**. After the heal the PR lands exactly as its label already said: `ready-to-merge` lands once re-run CI
  is green (the drain); a parked PR still awaits its human `/review`.
- **The CI-heal guard — its own bookkeeping, the SAME two-piece shape as the §3c fix guard (do NOT conflate the
  two counters).** A `{ pr, num, spawnedTick }` **in-flight ENTRY** keyed by PR number ("a CI-heal agent for this
  PR is live now"), plus a **per-PR attempt counter** `ciHealAttempts[pr]` that SURVIVES entry retirement. The cap
  binds on `max(in-session ciHealAttempts, durable prCiHealCounts)` — the durable floor derived from the PR's own
  **CI-heal comments** (`countCiHealComments`, one per completed heal), so a conveyor restart that wipes the
  in-session tally can never reset a PR that already burned its attempts (the #2643 design applied to the CI axis).
  These are SEPARATE from the fix loop's `fixGuards` / `fixAttempts` — a red PR is not a bounced PR.
- **Two suppressions and one cap** (mirroring §3c): (1) **in-flight test** — skip a PR with a live CI-heal ENTRY
  (a second red read on the same episode must not spawn a duplicate heal on a second burned lane); (2) **retry
  cap** (default 3) — at cap, **stop auto-healing** and surface for `/review` (`⚠ PR #N (#<num>) went red/BEHIND
  <k>× — auto CI-heal exhausted, run /review N`); a genuinely-broken diff needs a human, never an unbounded
  heal↔red flap. **Retire the ENTRY** (not the counter) when CI recovers (`ci` no longer `fail` / no longer
  BEHIND) or the PR goes terminal (`resolved`), or on **TTL** (default 5 ticks — the heal agent died before
  re-pushing; still cap-gated on re-dispatch). Clear `ciHealAttempts[pr]` only on PR-terminal.

### 3d. Surface every cleared epic for `/slice` — a cleared epic is a slice trigger, not a dead end (#2645)

An **epic** is a CONTAINER; its work lives in child stories/tasks, so the dispatcher **never** launches it to
build. A cleared `kind:epic` is held **`needs-slice`** (in `plan.held`) and surfaced in `state.needsSlice` (each
entry `{ num, epicState }`). Before this rule such an epic fell into a silent hole — never built, never sliced,
no signal. Now, each tick, for every item in `state.needsSlice`, **surface it to the operator** so it gets
decomposed into buildable children (which the conveyor then dispatches on later ticks):

- **Route by `epicState`** — the surfaced action depends on the epic's state (the same states the readiness view
  uses), so you never prompt a `/slice` on an already-sliced epic:
  - `unsliced` → **`/slice <num>`** — decompose it into buildable child stories. This is the core case.
  - `done` → **`/resolve <num>`** — every child is resolved; the epic just needs its explicit resolve, not a slice.
  - `tracking` → **no slice** — it already has open child slices; those children ARE the work (clear the children,
    not the container). Note it so the operator can `remove` the epic from the conveyor queue.
  - `program` / `parked` → **no slice** — a perpetual program, or a `childlessReason` gates decomposition; surface
    the state, never prompt a slice.
  - `null` (unknown — a loader-degraded read, or an epic armed while not open/unblocked, so `epicState` was never
    derived) → **surface, no auto-route** — show it as an epic awaiting attention; don't presume `/slice`.
- **Surface, do not auto-slice.** Slicing is human judgment (the `/slice` flow is gated on approval per the
  split-backlog-item skill), so the conveyor **surfaces** the epic rather than spawning an autonomous slice agent
  — the deliberately-chosen branch of the spec's "surface **or** auto-run" (auto-slicing an epic without a human
  in the loop is out of scope here). Add a line to the tick status, e.g.
  `⚠ N epic(s) need slicing: #A (/slice) #B (/resolve)`, so a cleared epic is **always** either
  sliced-and-dispatched (once the operator runs `/slice` and its children land + are cleared) or explicitly
  awaiting slice — never silently stalled.
- **No guard, no spawn.** Unlike §3b/§3c this dispatches **no** agent and consumes **no** lane, so it needs no
  in-flight guard — it is a pure per-tick SURFACE of `state.needsSlice`. The epic stays `needs-slice` every tick
  until the operator slices/resolves/removes it (idempotent — re-surfacing the same epic each tick is correct,
  it is a standing "awaiting slice" signal, not a repeated action).

### 3e. Drive every cleared decision — prepare then present (#2647)

A **decision** is NOT build work; its lifecycle is **prepare** then **present**. A cleared `kind:decision` is
held **`needs-decision`** (in `plan.held`) and surfaced in `state.decisions` (each entry `{ num, prepared,
preparedDate }`). Before this rule a cleared decision fell into the same silent hole an epic did — never built
(a decision isn't buildable), and worse, mislabeled `unshaped-no-scope` and aimed at a scope-prediction agent.
Now, each tick, for every item in `state.decisions`, route by its `prepared` flag:

- **UNPREPARED (`prepared === false`) → auto-prepare it: spawn ONE background prepare-decision agent.** This is
  the autonomous half of a decision (the `/prepare` skill is pure agent work — no human judgment yet). It
  mirrors §3b's auto-prepare-scope exactly, one kind over — **UNLESS a prepare for that `num` is already in
  flight** by the *prepare in-flight test* (the union rule below): **skip** re-dispatch when EITHER a live
  decision-prepare-guard entry exists for `num`, OR `state.prs` already has an **OPEN PR for that `num`** (while
  the decision is still un-prepared it has no build PR, so any open PR for its `num` can only be its in-flight
  prepare). Only when NEITHER holds do you spawn:
  - Resolve the item's spec path by **globbing `backlog/<num>-*.md`**.
  - **Pick a prepare lane that no build/prepare/guard already owns this tick** — the same lane-exclusion §3b
    uses (a `freeSlots` lane MINUS this tick's `plan.launch` builds MINUS every guard-held lane). A
    prepare-decision lane is parallel-safe with builds and other prepares: its scope is the one decision's item
    body plus a new `/research/` topic — disjoint from any builder's code scope.
  - Instantiate [`prepare-decision-agent-brief.md`](prepare-decision-agent-brief.md) by substituting its four
    placeholders: `{{ITEM_NUM}}`=`num`, `{{ITEM_SPEC_PATH}}`=the globbed `backlog/<num>-<slug>.md`,
    `{{LANE}}`=the picked lane, `{{SESSION_SLUG}}`=`prepare-decision-<num>`. Those four `{{DOUBLE_BRACE}}`
    tokens are the whole fill — do not rewrite the brief's prose.
  - Spawn it as **one background `Agent`**. It acquires its lane, prepare-holds the decision, runs the
    `/prepare` passes (prior-art research → per-fork classification → author the prepared-fork shape → skeptic
    pass → two-confusion screen → `prepare-stamp` the `preparedDate`), gets the gate green, **runs an
    adversarial review subagent on its prepared forks and addresses the findings to convergence BEFORE opening
    the PR**, then opens ONE `ready-to-merge` PR and `prepare-release`s the hold — **exits without merging**.
    When that PR lands the decision is prepared, so on a later tick `state.decisions` reads it `prepared:true`
    and this section presents it (below).
  - **Record a decision-prepare-guard entry** `{ num, kind: 'prepare-decision', spawnedTick }` — keyed by `num`
    (the contended resource is the decision's authorship). Its retirement is the SAME as §3b's prepare guard
    (retire only when the item leaves `state.decisions[].prepared === false`, i.e. its `preparedDate` landed, or
    the prepare PR closed) — a returning prepare-decision Agent does NOT retire its guard (it returns at PR-open,
    mid-flight).
- **PREPARED (`prepared === true`) → present its forks for ratification. Surface, do not auto-ratify.** A
  prepared decision is ready to *ratify*, and ratifying is human judgment (MEMORY #39 — *never take an unprepared
  decision*; and `/prepare` explicitly does **not** make the call). So — exactly like §3d surfaces an epic
  rather than auto-slicing — the conveyor **presents** the prepared forks and lets the human ratify:
  - **Publish a forks artefact in the chat conveyor** — the conversational surface. Read the prepared item body,
    and publish a self-contained artefact summarizing each `## Fork N` (its options, the bold default, the
    `Skeptic:`/`Screen:` verdicts) so the operator can see and ratify it inline. This is the main-session
    (chat) present channel.
  - **Feed the #2565 console decision-ratify (ruling) surface** — the product/UI conveyor's present channel. The
    console's ruling read/write ports (#2580 / #2581 / #2582) are already built; the autonomous feed that wires
    a prepared decision into them is a **cross-locus follow-up** (see the blocked follow-up item) — until it
    lands, note the prepared decision is available for the console ruling surface and rely on the chat artefact.
  - **Surface for `/next decision`** — add a line to the tick status, e.g.
    `⚖ N decision(s) ready to ratify: #A #B (/next decision)`, so a prepared cleared decision is **always** either
    ratified (once the operator makes the call) or explicitly awaiting ratification — never silently stalled.
  - **No agent, no guard for the present half** — like §3d it is a pure per-tick SURFACE of the prepared rows
    (idempotent; re-presenting each tick is correct — a standing "ready to ratify" signal). Only the *prepare*
    half (above) spawns an agent and carries a guard.

### 3f. Infra-blocked — a first-class state for a PRE-PR infra failure (#2659)

Between "the agent built + pushed its ref" and "the PR is open" there is a real failure window: `gh pr create`
can fail on an **outside dependency** (a GitHub partial outage — grounded in the 2026-07-24 incident that blocked
#2654's PR-open — or a network fault). That built + pushed work is **not** a review-park, a stall, or gate-red,
and the PR watcher can't see it (no PR exists). Before #2659 it was silently stranded. Now it is a **first-class
state** the conveyor owns end-to-end:

- **Recorded, never lost.** `pr-land` detects a KNOWN-transient PR-open failure (a GitHub 5xx / rate-limit /
  network fault — a genuine error like a bad body or "already exists" is NOT infra and still hard-fails, never a
  doomed retry) and records the **resumable handle** (the pushed `lane/*` ref + its tip + base + body) into the
  conveyor infra-blocked sidecar. It exits `blocked-on-infra` (exit 4), leaving `main` untouched.
- **Auto-retried + resume-opened.** The §4b recovery pass owns an idempotent exponential-backoff retry loop:
  once GitHub recovers it resume-opens the PR **from the recorded ref via `pr-land`** (which never merges — the
  drain lands it). At the attempt cap it stops and surfaces.
- **Reads DISTINCT from a stall or a review-park.** An infra-blocked lane shows the ⊘ marker with its failure
  class + retry attempt + countdown, and a widespread outage collapses into ONE **OUTAGE** banner (not N alarms).
  It is excluded from the stall/health scan, so it never mis-reads as a hung lane. When auto-retry is exhausted
  (the cap), the board reads "auto-retry exhausted — resume by hand" so the operator knows to intervene.
- **Nothing you do by hand.** `pr-land` records it, the §4b pass drives it, the board surfaces it. Surface a
  capped/exhausted item to the operator (like a park), and otherwise let the loop resume it.

## 4. Landing is the drain daemon's job — neither the runner nor this session ever merges

Delivery agents stop at `ready-to-merge` — but only **after** each has reviewed its own diff to convergence
(step above) and `pr-land --label-on-green` confirms the `test` check. The **resident drain daemon**
(`plateau:tools/drain-daemon/`) is the single landing serializer: it auto-lands green couples and parks
escalations `review:human` for review in this main session. **The runner decides dispatch and watch; it never
merges and never self-clears a human review.** This skill (the judgment plane) likewise **never runs `gh pr
merge` and never runs a drain** — the drain daemon is the sole writer to `main` (memory rule 104). `state.daemon`
reports the daemon's residency; if it reads `"unavailable"`, tell the operator the resident drain is absent
(escalations still park, but nothing auto-lands until it — or a manual `/drain` — runs).

**Escalation discipline — `review:human` is a good-reason hold, not a default.** Because every delivery agent
runs the adversarial review before opening its PR, a **clean, reviewed, non-statute PR with a green `test`
auto-lands via the daemon with no human in the loop** — that is the norm. Agents escalate `review:human` ONLY
for good reason — a **statute-touching** change, a **gate-red** PR, a **review finding that turns on a named
taste/product/policy call**, or **genuine uncertainty about one specific taste/product/policy call** (never a
blanket hedge) — and **never blanket-park** a clean PR "so a human can see it" (over-parking makes the human
the bottleneck the conveyor exists to remove and dilutes the label). **Diff size, line count, file count, or
unfamiliarity with the touched area are never grounds on their own** — `CARE_WEIGHTS.size`
(`scripts/lib/review-escalation.mjs`) already makes the committee look harder at a large diff, and the scored
rubric caps size at `review:pending`, never `review:human` (#2563); see the delivery-agent brief's Escalations
section for the full rule. Whether to escalate is **judgment**, kept with the agent rather than a script
([we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment](../../docs/agent/platform-decisions.md#deterministic-core-thin-judgment)).
A parked PR the runner surfaces (§3) is handled by its label: a `review:human` / `review:pending` park is
surfaced for `/review` in this session (never auto-landed — a human-only gate); a `review:changes` bounce is
auto-re-dispatched to a fix agent (§3c) that repairs and re-arms it — but the fix agent still **never
self-clears** the review, so the re-armed PR returns to `review:pending` for a human (or the AI-review pass) to
verdict, never straight to `review:accepted`.

## 5. State is the board's channels only — no parallel store

Everything the conveyor and its agents do flows through the **normal verbs**: `acquire` a lane → claim → build
in the `lane/<num>` branch → `pr-land` → the daemon merges → resolve. Those are **exactly** the channels the
plateau lane board reads (`claimed.session`, `queued.lane`, `pr.state`+`ci`, the scope-lease collect). So the
board reflects conveyor state **for free**, and `conveyor-state.mjs` reads that same truth. **Never keep a
parallel state store of item / claim / PR / resolve state** — the only bookkeeping allowed is ephemeral
*process* tracking, and since #2703 it lives in the **runner's** process (threaded through `nextState`, not this
session's context): which delivery / prepare-scope / prepare-decision / fix / CI-heal `Agent`s and which
`pr-watch` processes were spawned (the in-flight dispatch guard, the prepare-scope guard, the
**decision-prepare guard** (§3e), the in-flight **fix-guard ENTRY** (§3c), the in-flight **CI-heal-guard ENTRY**
(§3c-ci), and the watched-PR set). The two attempt counters (`fixAttempts` / `ciHealAttempts`) are session
overlays whose durable floor is the PR's own re-arm / CI-heal comments — the count IS PR state, not a parallel
store. That
is not item state; it is which background jobs are live — the re-arm swap and every repair still flow through the
board's normal verbs (`git push … lane/*` → `rearm-review.mjs` → the PR's labels → the daemon / `/review`).

The **auto-fix retry count** is the case that proves the rule (#2643): "how many times this PR was auto-fixed" is
**PR state, not process state**, so it must NOT live in a session-side map (a restart would wipe it and the cap
would silently stop binding). It **derives from the PR itself** — `countRearmComments(pr.comments)`, one durable
re-arm comment per completed auto-fix — so it survives a restart with no parallel store. The in-session tally the
mechanized guard also keeps is a within-session *overlay* over that durable count (it only adds coverage for a fix
agent that died before posting its re-arm comment); the durable comment thread is the source of truth.

## 6. Idle-stop (the runner stops itself; a fresh `/conveyor` restarts it)

Idle-stop is the tick core's decision (`decisions.idleStop`) and the **runner** acts on it — the main session
arms no `sleep` to stop. Two signals only: the **queue is empty** (no `buildQueued` items in `state.queue`, no
in-flight lanes/PRs) **AND** there has been **no operator feedback for the configured idle window** (default
15 min — measured from the last chat turn). When both hold, the runner STOPS its loop and releases its singleton
lease (it also stops on a lost lease or a spent `--max-ticks` budget). Announce the stop to the operator. The
conveyor does not outlive its purpose; a fresh `/conveyor` starts a new runner.

> `state.queue`'s `buildQueued` now reflects the SESSION-LOCAL conveyor queue (`.conveyor/queue.json`, #2613),
> so `state.queue.filter(buildQueued)` is exactly what the operator cleared this session — the reliable
> queue-empty half.
>
> **Do NOT gate idle-stop on `state.idle.lastQueueAdd`.** That field is sourced from the **drain's**
> `queued.json` (the ready-to-merge token queue), **not** the conveyor queue the operator feeds with
> `queue.mjs add` — a fresh clear never updates it, so it is the wrong signal for "was work queued recently".
> The queue-empty test above already reads the conveyor queue correctly (via `state.queue`), which is the
> reliable half; rely on queue-empty + operator-feedback and ignore the `lastQueueAdd` grace clause until a
> conveyor-queue clear timestamp is wired into the state read.

## 7. Final ledger (on stop)

When the runner stops — idle-stop, lease-loss, or the operator ends it — post one final ledger from the last
state read:

> **delivered** (merged this session) · **parked** (PRs awaiting `/review`, with numbers) · **stranded** (lanes
> whose PR closed/timed-out and need a look).

Release nothing yourself — delivery agents and the drain own their lanes; a stranded lane is surfaced, not
force-released, so the operator decides.

## 8. Interim status surface — the periodic artifact refresh (no product UI yet)

**WHILE the product console UI does not exist** (the Plateau-Loop console board — #2527 *autonomous AI build
queue*, #2505 *operable backlog console*, #2555 *launch review console board* — none of which is built yet), the
conveyor keeps a **live status board** the operator can watch. It is generated by a committed, dependency-free
script and republished as an **Artifact** on the same ~5-min heartbeat the runner ticks on:

```bash
node scripts/conveyor/status-artifact.mjs > /tmp/conveyor-status.html   # from the WE repo root
```

- **What it renders.** One self-contained HTML page (CSS inlined) — a KPI row (merged-today / building /
  in-review / landing), the four-stage flow (ready · in-review · landing · needs-you), the **lane pool** with
  ghost-lease flagging, an **"Epics — progress"** section with a per-epic child-state rollup, the buildable
  **remaining-backlog** table (epic rows excluded — they live in the Epics section), and **merged-today**. It
  reads the SAME live truth everything else does — `conveyor-state.mjs` + `dispatch-plan.mjs` +
  `lane-pool.mjs status` + `gh pr list` + a backlog scan — and invents no state (the *State* rule §5: no parallel
  store).
- **The generator is deterministic + READ-ONLY; the PUBLISH step is the SESSION's — name the seam honestly.** The
  script only shells reads and prints HTML to stdout — it mutates nothing (no repo write, no PR, no merge), so it
  is safe to run every heartbeat. What it does **not** do is publish: turning that HTML into a shareable Artifact
  uses the **Artifact tool, which is a session capability**, not something a headless script or the runner can
  call. So today the refresh is a two-step interim seam — *script generates (mechanical, reproducible) → this
  session publishes (a session-only capability)* — and that publish half is exactly what does not yet exist
  session-free. State it plainly rather than pretending the board hosts itself: it is a stopgap until the app
  hosts the board (below).
- **The heartbeat DOUBLES as the pipeline-drop check — refill prep proactively on every refresh.** Each ~5-min
  regeneration is also the cue to read the board for a **prep-pipeline drop** — idle lanes, or a thin `ready`
  queue (few scoped-and-dispatchable items) — and, when you see one, **refill the prep pipeline** so the
  conveyor never runs dry. The board surfaces exactly what to refill, and each maps to a mechanism this skill
  already owns: **needs-scope items → dispatch a prepare-scope agent** (§3b); **a cleanly-sliceable epic →
  `/slice` it into buildable stories** (§3d); **an unprepared decision → prepare it, and preview a prepared one
  for ratify** (§3e). This is the standing *keep the prep pipeline full proactively* discipline — don't wait for
  the `ready` queue to hit zero; top it up every heartbeat so scoped work is always waiting when a lane frees.
  (The runner's per-tick auto-prepare already does most of this mechanically; the heartbeat read is the judgment
  backstop that catches what needs an operator nudge — an epic to slice, a decision to prepare.)
- **This whole interim surface is RETIRED when the session-free product board lands.** The end state is the
  **Session-free conveyor** roadmap epic **#2753** (*reduce the operator session to queue + expose-state*), whose
  "residue" list names **board generation** as one of the things that moves into the session-free runner/app —
  i.e. the product console (#2527) hosts the live board and no session publishes an Artifact by hand. Until
  #2753's board-generation residue lands, this script + heartbeat-publish is the honest stopgap; when it does,
  delete this section and the periodic-publish habit with it.

---

## Daemon soak harness — every daemon bug fix adds its real-world case (#4075)

The resident daemons (review, fix-dispatch, the pass daemons) kept breaking live in ways their unit tests never
saw — seven breaks on 2026-09-25, all green in tests: runtime state files dirtying the daemon clone, the shared gh
shim pointing into a clone mid-rebuild, a ci-heal crash on an empty scope, a lane acquire timing out under load,
a silent lock wait, a skipped tick crashing `onTick`, a sticky smoke rejection. They lived in the seams between
processes, which only a long run of the real daemons shows.

`we:scripts/conveyor/soak/` is that long run: the REAL review and fix daemons, the real rebuild/self-sync and live
smoke gate, a throwaway daemon clone of a real bare remote with main moving, a fake GitHub with PRs in varied
states, and fake sessions that run the real state writers and sometimes crash, hang or leave junk. After EVERY
tick it checks: the clone is git-clean, at most one main move behind and never lagging, the tick finished inside
its bound, `tickOnce` and `onTick` did not throw, no stale-refusal streak, owed work got dispatched.

- `npm run test:soak` — the 50-tick soak plus one regression scenario per live break, all in one process (use
  this locally). CI splits the same coverage across a 4-way matrix (`we:scripts/conveyor/soak/shard-files.mjs`,
  `npm run test:soak:shard -- --shard=<i>/4`) — shard 1 is always the 50-tick baseline, shards 2-4 round-robin the
  break scenarios — behind the required `daemon-soak` check (an aggregator over the `soak-shard` matrix), on every
  PR touching `we:skills-src/conveyor/`, `we:scripts/conveyor/`, `we:scripts/lib/daemon-*`,
  `we:scripts/lib/gh-app-shim.mjs`, `we:scripts/lib/main-staleness.mjs`, `we:scripts/lane-pool*`,
  `we:scripts/review-set-label.mjs` or `we:scripts/operations/*dispatch*`. A new break scenario file lands in a
  shard automatically — no shard list to update.
- `node scripts/conveyor/soak/run.mjs soak|break <id>|list` — the same runs from a shell, one report line per tick.
- **THE RULE: every daemon bug fix adds its real-world case** as a scenario in `we:scripts/conveyor/soak/breaks/`
  and proves it with `node scripts/conveyor/soak/red-green.mjs --break=<id>` (RED on the tree before the fix,
  GREEN with it). The fix-agent brief carries the same rule. A break whose fix is not yet on the tree under test
  runs as a titled expected-fail (its card named), never a silent skip, and turns into a required pass by itself
  when the fix lands.
- **MECHANICALLY ENFORCED (#4075)**, not left to prose alone — a PR that touches daemon-soak scope and reads as
  a bug fix, but adds/changes no `we:scripts/conveyor/soak/breaks/` file, goes red under the `soak-replay-gate`
  check (`we:.github/workflows/soak-replay-gate.yml` → `we:scripts/lib/soak-replay-gate.mjs`) unless the PR body
  carries an explicit `soak-waiver: <non-empty reason>` line. Operator-approved after only 2 of ~12 recent
  daemon fixes added one on their own.

## The split, restated (why this skill is safe to keep thin)

Per #deterministic-core-thin-judgment (#2607) and its child #conveyor-orchestration-mechanics-not-per-lane-agent
(#2701), the line runs between **two planes**:

- **The mechanical plane — the HEADLESS RUNNER + the scripts it shells (deterministic, tested; no model context
  per tick):** the runner (`skills-src/conveyor/runner.mjs`, #2702) stepping the **mechanized tick core** (#2699
  — `scripts/conveyor/tick-core.mjs`: the guards + their retirement, the union re-dispatch gate, watcher arming,
  and idle-stop, all decided in one pure call the runner threads forward, never re-derives), over the tick state
  read, the dispatch plan, the merge-watcher verdict, the idle-clock inputs, the health/stall scan, and the
  **infra-blocked classify + backoff + resume decision** (#2659 — what counts as a retryable outage, the retry
  schedule, and when to resume vs surface are all in `scripts/conveyor/infra-blocked.mjs`, never re-derived in
  prose). Same inputs → same output. Since #2703 this whole plane is the runner's, not the main session's — the
  serial main-session tick loop is retired.
- **The judgment plane (stays with the operator + this main session + the agents — this skill's real content):**
  the readiness discussion,
  clearing items for build, supervising a build, **each prepare-scope agent's touch-set prediction**, **each
  delivery agent's adversarial review of its own diff**, **each fix agent's application of the reviewer's
  finding** (the repair itself — routed by the deterministic exit-2 label, but the fix is judgment), the
  **escalate-or-auto-land call**, reviewing an escalation (`/review`), and investigating an anomaly. The
  `review:changes → review:pending` re-arm, by contrast, is a script-decidable swap (`rearm-review.mjs`) — the
  fix agent shells it, never re-deriving the "never clear the human gate" rule in prose. Never spend model context re-deriving a computable plan —
  read the script's answer and act on it. **Build-vs-prepare-vs-slice-vs-decide is NOT a judgment call here — it
  is the dispatch plan's classification:** `plan.launch` → build (scoped, §3); `held: unshaped-no-scope` /
  `state.unshaped` → prepare scope (unscoped, §3b); `held: needs-slice` / `state.needsSlice` → surface for
  `/slice` (an epic container, §3d); `held: needs-decision` / `state.decisions` → prepare-or-present a decision
  (§3e — an UNPREPARED one spawns a prepare-decision agent; a PREPARED one is surfaced/presented for ratify, no
  agent). The runner surfaces the matching decision and — until the headless agent-runner backend lands — the
  judgment-layer bridge spawns the matching agent (or, for an epic or a prepared decision, surfaces it — no
  agent). Starting/supervising the runner is itself part of this plane. The one judgment that stays human
  throughout: **ratifying** a presented decision (never autonomous).
