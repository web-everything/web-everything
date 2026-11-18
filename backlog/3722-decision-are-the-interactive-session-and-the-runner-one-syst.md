---
bornAs: xaypr56
kind: decision
parent: "3718"
status: open
relatedTo: ["3383", "3031", "2615", "2626", "2701", "2612", "3070", "3639", "3720", "3721", "3118", "2742"]
relatedReport: reports/2026-09-21-session-runner-one-system-grounding.md
dateOpened: "2026-09-19"
preparedDate: "2026-09-21"
preparedAgainstSha: "b69c470aaab76bd28169d63a353b459576affac9"
tags: []
---

# Decision: are the interactive session and the runner one system, or two systems that share operations?

The operator wants a live session and the runner to add work and handle it identically. Most of the seams exist. This item rules whether to converge on one system (the session becomes one more caller of the same operations) or keep two systems over shared operations, and settles the places the two currently differ: the loop's owner (Fork 1), how a person differs from no person (Fork 2), and where shared state lives (Fork 3). It also ratifies one launch-model target (the Ratify section).

*Prepared 2026-09-21 (session prep-3722).* No design exists yet for the shared state home or the run-to-completion launch, so the three forks and the ratify below are grounded in a prior-art survey published as [/research/session-runner-one-system/](/research/session-runner-one-system/) (session report: `we:reports/2026-09-21-session-runner-one-system-grounding.md`), a read of the code, and five live probes of `claude -p`. Each fork carries a recommended default in **bold**.

**What the research changed.** The card's framing moved in five places:

1. "Derive, do not store" is already the pattern for guard bookkeeping, so it is not a fork. The build guard has a restart-surviving floor read from the agent listing (`we:scripts/conveyor/tick-core.mjs:393-418`, #3403). The fix and ci-heal caps read the PR's own re-arm comments (`we:scripts/conveyor/tick-core.mjs:83-88`, #2643 and #2666). What is broken is that the durable facts these lean on are per-checkout files (Fork 3).
2. The card's "three liveness models" are one source read a few ways. The lane lease pid is dormant, so it is not a model (`we:scripts/lane-pool.mjs:989-1000`, `we:scripts/conveyor/lease-reaper.mjs:58-67`). See "Settled by inspection".
3. "Real differences: keep them, and design for them" was a live choice left as prose, resting on a premise the record contradicts. It is now Fork 2.
4. Run-to-completion workers, listed as "unverified" on the card, work on five probed axes but are not a launch-flag change: the prep skeptic found a detached supervisor is needed, a lane-lease hazard for `kind` other than `background`, and an unprobed permission profile. It is therefore ratified as the target with the build gated on three preconditions, and the resident model plus a deadline reaper is the bridge (the Ratify section).
5. The prep skeptic also corrected two claims the first draft made: pause and the lane ceiling are enforced only in the planners today (so "every gate binds every caller" is a build, Fork 2), and the primary checkout can be derived from a lane clone (Fork 3's reason to prefer a fixed home is the runner-down case, not that).

## Already ruled (so it is not a fork)

- [#operations-declared-once-callers-generated](../docs/agent/platform-decisions.md#operations-declared-once-callers-generated) (#3031): an operation is declared once and every caller is generated from it. It retired the in-session reviewer because "the same operation behaves differently depending on who started it".
- [#conveyor-dispatch-calls-the-declared-operation](../docs/agent/platform-decisions.md#conveyor-dispatch-calls-the-declared-operation) (#3118, clause 2): "the runner becomes a caller, not a backend". The dispatch step is already settled; this item extends the same principle to plan, claim and settle.
- [#conveyor-orchestration-mechanics-not-per-lane-agent](../docs/agent/platform-decisions.md#conveyor-orchestration-mechanics-not-per-lane-agent) (#2701): no per-lane conducting agent; the runner is mechanics and novelty escalates.
- [#event-driven-land-is-wake-only](../docs/agent/platform-decisions.md#event-driven-land-is-wake-only) (#2692): an event only wakes a caller; the caller re-derives from real state and never trusts the event's payload.
- [#state-lives-where-its-nature-dictates](../docs/agent/platform-decisions.md#state-lives-where-its-nature-dictates) (#2615, #2626): transient operator intent lives outside committed frontmatter; the shared store (DO/D1) is coming behind each store's seam, tracked as #2742. This item does not reopen either.
- Epic #3383's target shape: the session's role narrows to queueing work and being told about blocked items.

## Settled by inspection (also not forks)

- **Guard bookkeeping stays derived.** `we:scripts/conveyor/tick-core.mjs` takes its ephemeral guards on STDIN (`:33-36`, `:1435-1447`) only because the runner ticks. A caller that does not tick (a hook or session calling `land-advance`, #3720) is stateless and leans on `dispatch-lane`'s run-record guard, `claim` and the lane lease. Ratify as the rule; no choice is left.
- **There is one liveness source, not three.** Every reader shares `defaultListAgents` (`we:scripts/operations/dispatch-lane-io.mjs:1793`, with its session-id comparison at `:443`, and its callers in `we:scripts/conveyor/session-reaper.mjs:114`, `we:scripts/conveyor/lease-reaper.mjs:78`, `we:scripts/conveyor/reconcile-pass.mjs:50`). The lane lease's `pid` records the short-lived `acquire` CLI, not the agent, so that axis is dormant. Lease liveness is a TTL plus the session name matched against the listing. The run record's `lastSeenLiveAt` is a cache of the listing (`stampLiveness`, `we:scripts/operations/dispatch-lane-io.mjs:523`). The one predicate is `alive(session) = listed(session) and not completion-done(session)`. The Ratify section decides how a worker comes to satisfy it.
- **Who arbitrates two callers acting at once is already answered.** The lane lease is an atomic per-lane claim built for concurrent acquirers, `claim` is atomic, and `dispatch-lane` refuses a second dispatch for an in-flight item. Prior art (Kubernetes `resourceVersion`, Temporal overlap policy) asks for exactly this. The only weak spot is that the run-record guard is per checkout, which is Fork 3.

## The seams, after the read

| Step | Shared today (one implementation) | Not shared |
|---|---|---|
| Plan | `we:scripts/conveyor/tick-core.mjs` `planTick`; `we:scripts/conveyor/reconcile-pass.mjs` | Nothing a stateless caller needs: build floor and fix/ci-heal caps are derived. |
| Add work | `we:scripts/operations/file-item.mjs` | Its queue write resolves the runner's checkout only while a runner is live (`we:scripts/operations/file-item-io.mjs:63-71`); otherwise the caller's own file. Fork 3. |
| Claim | `we:scripts/operations/claim.mjs`, lane lease in `we:scripts/lane-pool.mjs` | none |
| Dispatch | `we:scripts/operations/dispatch-lane.mjs` (declared, run record, in-flight guard); `we:scripts/conveyor/reconcile-fix-dispatch.mjs` calls it | `we:scripts/operations/review-dispatch.mjs` is a plain module by its own header: no run record and no in-flight guard. Hand-launched workers (#3730). `dispatch-lane`'s guard reads a per-checkout run store (`we:scripts/operations/dispatch-lane-io.mjs:417`). Pause and the lane ceiling are checked only in the planners (Fork 2). Fork 3. |
| Settle | `we:scripts/operations/operator-queue.mjs` | the runner's tick output and the operator queue are separate surfaces (presentation only, no state) |
| Alive? | one source (`defaultListAgents`) | a finished worker that stays listed (the Ratify section). |

## Recommended path at a glance

| Fork | Recommended default | Main alternative | Confidence |
|---|---|---|---|
| Fork 1: who owns the loop | (a) One loop, expressed as operations; every actor (runner, hook, session) is a caller | (b) Two systems over shared leaf operations (today) | High. Three ratified statutes point here |
| Fork 2: how the one loop treats a person vs. no person | (a) Resource gates (pause, capacity, load, lane, in-flight) bind every caller, enforced inside the operation; caller kind changes only how a refusal is delivered; a recorded per-call override replaces "clear the pause" | (b) An attended session bypasses pause, capacity and opt-in ("supervised by construction") | High on the rule; the enforcement is a build |
| Fork 3: where shared operational state lives until #2742 | (b) One machine-level home outside any checkout, for every store more than one actor reads or writes | (a) One resolver to the live runner's checkout, else the primary checkout (the card's default) | Medium. The real call |
| Ratify (not a fork): launch model for one-turn workers | Confirm run-to-completion (`claude -p`) as the target for review, fix, ci-heal; build gated on three preconditions; the completion-record plus deadline reaper ships meanwhile | (none: the resident model wins no merit case once both are free; it stays for build and prepare) | Medium-high. Model is not in doubt; readiness is |

---

## Fork 1: who owns the loop (plan, claim, dispatch, settle)

*Why this is a fork:* the branch that keeps two loops (b) is excluded by two ratified rules, not by a new argument: #3031 clause 3 ("the same operation behaves differently depending on who started it") and #3118 clause 2 (the runner is a caller). The drift it names is measurable: hand dispatch skips the pause and the lane ceiling that only the planners enforce (Fork 2), and a hook in another checkout reads different state (Fork 3). The runner-only branch (c) is excluded because it removes the human path. With #2703 resolved (the main-session serial loop is retired), no by-hand session loop is left to keep, so (b) survives only as un-converged dispatch paths, which #3096 (open) and the two-chokepoint ruling in [#dispatch-status-ground-truth-check](../docs/agent/platform-decisions.md#dispatch-status-ground-truth-check) already name as follow-on.

Concern axes: the loop's *steps* (plan, claim, dispatch, settle) and its *callers* (a clock, a completion event, a person). Steps are already operations or `planTick` (`we:scripts/conveyor/tick-core.mjs:1010`); callers are the open part.

- **(a) One loop, expressed as operations; every actor is a caller. [default]** The steps are declared operations (`land-advance` for plan and dispatch (#3720), reconcile, the session reaper, the operator queue for settle). The runner becomes an optional scheduler that calls them on a clock; a completion hook calls them on events; a session calls them on demand. No caller carries its own copy of the loop. The session's own job is adding work (`file-item`), answering what the operator queue surfaces, and judgment. This is #3031's rule carried from the operation to the loop around it, and #3118 clause 2 already applied it to dispatch.
- **(b) Two systems that share leaf operations.** The runner keeps `planTick`; the session keeps a by-hand loop; both call `dispatch-lane`. Cheapest now, and it is what exists. Rejected: it is the shape #3296 was filed to escape, a proxy (session memory) standing in for a fact.
- **(c) Runner only; the session may not dispatch at all.** Rejected: the operator deliberately runs the runner stopped, ad-hoc work would have no path, and a human could no longer act faster than a tick. Prior art agrees the human stays a caller: GitHub's merge queue takes humans and bots through the same queue, and a Temporal schedule and a manual trigger start the same workflow.

Known occurrences: the merge-queue bots (humans and bots share one entry point), Temporal schedules with `trigger`, one GitHub Actions workflow with several triggers, and this repo's own retired in-session reviewer (#3031).

Codifies as: a fifth clause on #operations-declared-once-callers-generated ("the loop, not only the leaf"). What wakes a caller is #3070's decision, not this fork's. #2612 (open) still describes the main session as the operator seat that drives ticks; #2703 retiring that loop is what makes the session a caller, so #2612's skill text is what gets thinner. #dispatch-status-ground-truth-check ruled "support both" for a *check* at two chokepoints and named their convergence as #3096's; this fork is that convergence stated as a rule, not a reversal.

Skeptic: SURVIVES-WITH-AMENDMENT — beat the attack that (b) is only a hypothetical. The attack showed the first draft's evidence was wrong (the 2026-09-19 freeze came from the runner's own `planReconcile` liveness check, which is Fork 4's defect, not two-loop drift), so the exclusion now rests on #3031 clause 3 and #3118 clause 2 plus the pause and ceiling gap; it also corrected the seams table (`review-dispatch` is not a `dispatch-lane` caller) and added the #3096, #2703 and #2612 relations above.
Screen: clear

## Fork 2: how the one loop treats a person versus no person

*Why this is a fork:* the card left "keep the real differences, design for them" as prose, so how they are kept was an unmade choice. The branch that lets a session bypass gates (b) is excluded because it makes the same operation behave differently by who started it, which #3031 rules out, and because its stated premise ("a session's dispatch is supervised by construction") is contradicted by the record.

The evidence, stated exactly. `we:scripts/readiness/dispatch-pause.mjs:1-16` says the pause stops all new dispatch of every kind, and the lane ceiling is "a STANDING ceiling the dispatcher always respects". But both are checked only in the planners (`dispatchPlan`, `planTick`): `isDispatchPaused` is read by no `dispatch-lane`, `review-dispatch` or `reconcile-fix-dispatch` module, and #3727 (open) records that review and fix dispatch have no admission check. So a hand dispatch bypasses both today, and #3720 records load 28 against the host core count on 2026-09-19 from exactly that, with a person present. "Supervised by construction" did not hold, and Fork 2 (a) is a build (move the resource gates into the operation), not only a rule.

- **(a) Resource gates bind every caller and are enforced inside the operation; caller kind is recorded and never read by a resource gate. [default]** Pause, capacity, load, lane and in-flight gates bind a session, a hook and the runner equally. A refusal to an unattended caller escalates to the operator queue; the same refusal to a session is answered to the person. To act during a pause, any caller passes a declared `overridePause` input with a reason, and the run record stores it; clearing the pause is the wrong tool because it also opens the gate for the runner and hooks. Two identity gates already exist and stay, because they guard independence and consent, not resources: the reviewer's self-clear refusal keyed on session id (`we:scripts/lib/review-independence.mjs`, kept by #3031 clause 3) and `confirm` steps that need a person. An unattended dispatch's explicit opt-in (#3720's plan-only default) is a declared input, not caller-identity code.
- **(b) An attended session bypasses pause, capacity and opt-in.** The card's stated design. Rejected for the reasons above.
- **(c) Gates bind by caller kind, declared per gate (`binds: all | unattended`).** Same failure as (b), made explicit. Rejected: it turns every future resource gate into a per-caller decision and reopens the overload.

```js
// Fork 2 (a): caller is telemetry (#3427 already records caller kind), never a branch; the override is data
await runOperation('land-advance', { caller: 'session', dispatch: true, overridePause: 'red main: dispatching its fix' });

// Fork 2 (b)/(c): the shape it rejects
if (input.caller === 'session') skipGate('dispatch-paused'); // "supervised by construction"
```

Known occurrences: Temporal and GitHub Actions tell callers apart with a trigger name recorded on the run (`github.event_name`), not with different code paths.

Statute overlap: does not collide with #event-driven-land-is-wake-only (a wake is never an order; this says the order is gated the same for everyone) and preserves #3031 clause 3's identity gate. It leans on the pause lever's header (#3609), whose "ALL" it makes true in code.

Skeptic: SURVIVES-WITH-AMENDMENT — beat the attack that identity gates make "caller is never read" false. The absolute wording is narrowed to resource gates and the two existing identity gates are named; the attack also found the pause is planner-only today (so this fork is a build), and made the recorded per-call override the answer to "I need to act during a pause" instead of clearing it globally.
Screen: clear

## Fork 3: where shared operational state lives until the shared store (#2742) lands

*Why this is a fork:* the "GitHub label or committed frontmatter" branch (c) and the "per-checkout state plus a sync" branch (d) are excluded (below). Between the two survivors, (a) and (b) are two ways to choose the ONE path every caller reads, so they cannot both be the resolver: two resolvers for one file recreate the split.

The defect, verified: seven stores each resolve their root from the SCRIPT location, so a hook or session in a lane clone reads and writes that clone's own files: the queue (`we:scripts/conveyor/queue-store.mjs:130`), the pause marker (`we:scripts/readiness/dispatch-pause.mjs:106`), run records (`we:scripts/operations/run-store.mjs:46`), completion records (`we:scripts/operations/completion-store.mjs:38`), infra-blocked (`we:scripts/conveyor/infra-blocked.mjs:331`), the jury ledger (`we:scripts/lib/jury-ledger.mjs:58`) and the red-main freeze marker (`we:scripts/readiness/red-main-remediation.mjs:44`). Run records and completions are the durable facts Fork 1's stateless callers rely on, so "derive from run records" inherits the defect. The effect: an empty pause marker (dispatch goes ahead while the operator paused; the marker fails open), an empty run store (an in-flight dispatch is missed), an orphan queue. The lane pool and the runner lock (`we:skills-src/conveyor/runner-lock.mjs:44`, under `~/.claude`) are already machine-level.

- **(a) One resolver to the live runner's checkout, else the primary checkout.** The card's default, and what #3478 built for the queue (`we:scripts/conveyor/resolve-runner-checkout.mjs`, `we:scripts/operations/file-item-io.mjs:63-71`). Rejected as the default: it answers only while a runner is live, which is when the failure occurs (the runner was down on 2026-09-19 and sessions worked by hand); it needs `lsof` to find the runner's cwd; and its "else primary" fallback is derivable only from a lane clone's `.git/objects/info/alternates`, which a shallow clone (every cloud VM) does not have (`we:scripts/lib/lane-pool-paths.mjs:94`, `referenceArgs`).
- **(b) One machine-level home outside any checkout. [default]** Every checkout resolves the same directory with no discovery. Two precedents already exist for a workspace-level home computed from any checkout or lane: the pool-root `.admission/gh` and `.admission/heavy` locks (`defaultPoolRoot`, `we:scripts/lib/lane-pool-paths.mjs:65`; `we:scripts/lib/gh-throttle.mjs:151-154`) and the workspace-level `.operations/` (`we:scripts/operations/explore-io.mjs:166`, `we:scripts/operations/handoff-home.mjs`). The ruling is "one machine-level home, one namespace"; the sketch below hosts it under the pool root, and two homes must not both exist. Sketch: `<home>/state/<repo>/<instance>/`, `<instance>` defaulting to `main`. Env overrides (`CONVEYOR_QUEUE_FILE`, `OPERATION_RUNS_DIR`, `WE_DISPATCH_PAUSE_FILE`) stay for tests. It moves every store that passes #2626's own test (read or written by more than one actor across checkouts): the seven above. Stays local by nature: the advisory `.conveyor/*.lock` files, `we:.claude/lane-ports.json`, the learnings drop-box. It is the interim shell behind each store's existing seam; #2742 replaces it, not the callers. Three build-time conditions ride the default: (i) the runner lease records the home it resolved, and a caller that resolves a different one (a differing `LANE_POOL_ROOT`, say) refuses to dispatch and logs, because the fail-open pause marker would otherwise read empty silently; (ii) read-modify-write uses a real short-critical-section lock (a bounded-spin `O_EXCL` lockfile), and covers `persistLastSeenLive` as well as the queue, because `we:scripts/readiness/file-locks.mjs` is a non-blocking reservation with a 15-minute lease under a per-checkout `.claude/locks` and is not that; (iii) #3639 (open) recommends named instances as per-name subdirectories under `.conveyor/`, so the two decisions share one namespace: this fork rules the home, #3639's instance name is its last path segment, and two checkouts no longer mean two queues for free, so a dogfood runner must be given an explicit instance name.
- **(c) Move the queue into GitHub (a label) or committed frontmatter.** Visible from any clone. Rejected: it reverses #2615 clause 1 and #2626's ruled direction (DO/D1), and GitHub labels have no compare-and-swap, so two callers can both read "unclaimed" and both claim.
- **(d) Keep per-checkout files and add a sync.** Rejected: a fourth store to keep consistent. No surveyed system does this (git notes, the closest, need a manual fetch and merge).

```js
// Fork 3 (b): every store resolves through one function, not its own script location
// today, we:scripts/conveyor/queue-store.mjs:130
export const QUEUE_ROOT = resolve(HERE, '..', '..');
// after: one resolver, env override first (tests), then the shared home (root derivation as ghThrottleLockRoot)
export const stateHome = (checkoutRoot, repo, instance = 'main') =>
  process.env.WE_STATE_HOME ?? join(defaultPoolRoot(checkoutRoot), 'state', repo, instance);
export const queuePath = (...a) => join(stateHome(...a), 'queue.json');
```

Known occurrences: the lane pool, the runner lock and the `.admission/*` lock roots already put cross-checkout state at a machine-level root; bors ended at a store plus a re-sync from GitHub rather than per-process files.

Statute overlap: amends clause 1 of #state-lives-where-its-nature-dictates (its named paths become a per-repo machine-level home). The nature of the state (transient, unpoliced by the card-mutation guard) is unchanged, and #2626's vendor-abstraction amendment still holds: the home is behind each store module's IO shell. The "last write wins" note in `we:scripts/conveyor/queue-store.mjs` is replaced by condition (ii).

Skeptic: SURVIVES-WITH-AMENDMENT — beat the attack that (a) is simpler and already built. The attack disproved the first draft's reason ("primary cannot be derived from a lane clone" is false while the alternates file exists) and found three more per-checkout stores, a lock that is not a mutex, a competing workspace-level home, and a namespace clash with #3639. All are folded in above; the default survives on the runner-down and `lsof` grounds, which no attack touched.
Screen: clear

## Ratify: run-to-completion is the target launch model for one-turn workers (accepted on merit; adoption gated)

**Verdict: go on the model, not-yet on the build.** This is not a fork. Imagine both launch models free to build and instantly maintained: run-to-completion (`claude -p`) wins, because `alive` then means "working" by construction, including for an agent that crashes or never reports, and it supplies the `pid` the reconcile refusal needs. No merit case for keeping a finished session resident survives that test. What is left is readiness, which is ordering, not a ruling. So the decider confirms the target; the build is gated on three preconditions and a bridge ships meanwhile.

*Why this is not a fork:* the resident model's only merit claims (consistency with #3118's `--bg` backend, `review-dispatch`'s no-permission-bypass design, the `awaiting-permission` signal) all rest on the worker permission profile under `-p`, which is unprobed, so they are unknowns to test, not a rival merit. Resident-plus-reaper is also not excluded: it stays as the backstop for kinds that keep `--bg` (build, prepare), so the two coexist across kinds.

**Prior-art delta.** A Kubernetes Job that must exit, ephemeral CI runners that de-register after one job, and native sidecars that stop with the main container are all the same fix for the same "alive but finished" problem. The platform's own agent view takes the other path (stop an unattached finished background session after about an hour). In this repo `claude -p` already runs headless agents (`we:scripts/lib/judge-spawn.mjs:572`, `we:scripts/operator/dispatch.mjs:433`). Probes on 2026-09-21 (CLI 2.1.278): `claude -p -n <slug>` exits with code 0 when its turn ends, is listed in `claude agents --json` as `kind: interactive`, `status: busy`, with a `pid` and its `-n` name while running, leaves the listing on exit, and resumes by the same session id with `claude -p --resume <id>`.

**The three preconditions (the un-gate trigger), from the prep skeptic:**

1. **A supervisor, whose shape is #3627's open call.** `defaultSpawnAgent` is a blocking `execFileSync` with a 60-second kill (`we:scripts/operations/dispatch-lane-io.mjs:1037-1041`, `:729`), so a `-p` argv swap would kill the worker at 60 s or block the tick. A detached supervisor that records pid, exit code and session id is what #3627's wrapper sketch is (`we:scripts/operations/deliver-item-wrapper.mjs`). `we:scripts/operator/dispatch.mjs:433` is already a second detached `-p` spawner (with `bypassPermissions`), which #3118 clause 1 ("one spawn implementation") would have to absorb.
2. **Every consumer that filters on `kind === 'background'` becomes name-grammar-driven.** `we:scripts/conveyor/session-reaper.mjs:140` never touches a `-p` row (right for an exiting process, wrong for a hung one), and `we:scripts/conveyor/lease-reaper.mjs:265` (`sessionStateByName`) also skips it, so a live `-p` `fix-<pr>` worker reads as absent after the 10-minute grace (`sessionGoneForLease`, `:345-357`) and its lane lease is force-released while it runs. Interactive rows carry no `id`, so `resumeSucceeded` would always answer `resumed:false`; the launch pre-mints `--session-id`, which `-p` honours (`we:scripts/operations/review-dispatch.mjs:44-47`).
3. **A probe that a review, fix and ci-heal brief runs to completion under `-p` with the worker's real permission profile.** Commit `9d5a8c2dd` routed the reviewer spawn through `review-dispatch` (`--bg`) for zero permission bypass; under `-p` a permission prompt becomes a silent denial, and a worker that starts background subagents holds `-p` open up to a 10-minute ceiling (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`).

Un-gates when #3627 is ruled, precondition 2 is done, and precondition 3's probe passes. Scope when it un-gates: the one-turn kinds only (review, fix, ci-heal); build and prepare stay `--bg`, since they are long multi-step work with no evidence they cause the problem.

```js
// Kept for now (and for build / prepare afterwards): we:scripts/operations/dispatch-lane-io.mjs:1115-1121
['--bg', '-n', slug, '--append-system-prompt-file', file, prompt]
// The target for review / fix / ci-heal: a detached supervisor runs this and records pid, exit code and session id
['-p', '-n', slug, '--session-id', mintedId, '--output-format', 'json', '--append-system-prompt-file', file, prompt]
```

**Supported by default (not a decision): the bridge.** Ship #3721 (the completion record as a reap axis) plus a deadline axis: a `started` record with no `done` that outlives the dispatch record's own `expectedBy` (`we:scripts/operations/dispatch-lane-io.mjs:410-436`) is reaped, so a crashed or forgetful worker's poison window is bounded by a deadline the dispatcher already writes. It is needed under either model for the resident kinds.

Statute overlap: leaves #3118 untouched today; at un-gate, clause 1 holds only if the supervisor is `dispatch-lane`'s and `we:scripts/operator/dispatch.mjs` is retired into it. Clause 3's stop-then-resume already works for `-p` (resume verified).

Skeptic: SURVIVES-WITH-AMENDMENT — the first draft made run-to-completion the adopt-now default of a Fork 4; the attack REFUTED that: the launch is not "an argv choice inside `dispatch-lane`", a live `-p` worker's lane lease would be force-released, and the permission profile is unprobed. The merit case was not refuted, so the item now ratifies the target and gates the build on the three preconditions above. The fresh-context screen then flagged the resulting "adopt (a) now" fork as prioritization, so it was dissolved from a fork to this ratify-plus-trigger.
Screen: flagged(prio) → fixed: the "adopt (a) now" fork was dissolved into this ratify-plus-trigger (merit conceded to run-to-completion, only ordering left, so no `## Fork N` and no separate ratify turn beyond confirming the target).

## Where the two genuinely differ, and where it is only history

**Real differences** (kept, and expressed under Fork 2 and the Ratify section): a person is present in a session and the runner has none, so a stood-down agent, a ratification, a semantic merge conflict, a duplicate-PR keeper and "what should we build next" are judgment the runner must escalate to `we:scripts/operations/operator-queue.mjs`, never guess.

**Merely historical** (removed by the forks above): hand-dispatching with bespoke prompts, job files kept by hand beside run records (#3730), guards held in a session's head instead of derived, the session re-polling GitHub for what a pass already computes, per-checkout files (Fork 3), and a finished worker that stays alive (the Ratify section).

## What a ruling unlocks (carved at resolve, never guessed now)

- Fork 1: no new build beyond #3720 (`land-advance`) and the digest slices (#3724, #3726); the session's `/next` and `/wip` become callers.
- Fork 2: move the pause and lane-ceiling checks into `dispatch-lane`, `review-dispatch` and `reconcile-fix-dispatch` (overlaps #3727), add the recorded `overridePause` input, and a test that a session-kind call is refused under a set pause. Predicted scope for its child: `we:scripts/operations/dispatch-lane.mjs`, `we:scripts/operations/review-dispatch.mjs`, `we:scripts/conveyor/reconcile-fix-dispatch.mjs`, `we:scripts/readiness/dispatch-pause.mjs`.
- Fork 3: one `stateHome` resolver used by the seven stores, a one-time read of the legacy in-tree files, the three build-time conditions, and the clause 1 amendment in `we:docs/agent/platform-decisions.md`. Predicted scope for its child: `we:scripts/conveyor/queue-store.mjs`, `we:scripts/readiness/dispatch-pause.mjs`, `we:scripts/operations/run-store.mjs`, `we:scripts/operations/completion-store.mjs`, `we:scripts/conveyor/infra-blocked.mjs`, `we:scripts/lib/jury-ledger.mjs`, `we:scripts/readiness/red-main-remediation.mjs`, `we:scripts/lib/lane-pool-paths.mjs`, `we:docs/agent/platform-decisions.md`.
- Ratify section: #3721 (the completion-record axis) plus a deadline axis on `expectedBy` for a `started` record that never reached `done`. Predicted scope for that addition: `we:scripts/conveyor/session-reaper.mjs`. Run-to-completion has no slice until its three preconditions clear.

## Concrete code to read before ruling

`we:scripts/conveyor/tick-core.mjs` (`planTick`, `durableBuildNums`), `we:scripts/conveyor/reconcile-core.mjs` (the `live-process` refusal at `:355-375`), `we:scripts/conveyor/queue-store.mjs`, `we:scripts/conveyor/resolve-runner-checkout.mjs`, `we:scripts/operations/run-store.mjs`, `we:scripts/operations/dispatch-lane-io.mjs`, `we:skills-src/conveyor/runner.mjs` (`makeCliMechanicalPasses`), `we:scripts/conveyor/session-reaper.mjs`.

## Done when

1. **Executable** — ratified by the operator and recorded in a `## Ruling` section; the forks it settles are then carved into slices under #3718.

### Review jury (provisional — pre-registered #2638)

Care level: `elevated`. This jury binds against the item's predicted scope and is re-checked against the real diff at PR open.

| juror | lens | grounding method | pre-registered expectation |
| --- | --- | --- | --- |
| correctness#1 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. |
| security#1 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. |
| simplicity#1 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| standards-conformance#1 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| claim-accuracy#1 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |
