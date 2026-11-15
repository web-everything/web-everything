---
bornAs: x3vjug7
kind: decision
parent: "4075"
status: resolved
dateOpened: "2026-09-26"
dateStarted: "2026-11-15"
dateResolved: "2026-11-15"
codifiedIn: docs/agent/platform-decisions.md#conveyor-flows-executable-config
preparedDate: "2026-09-26"
preparedAgainstSha: "00413a56cc1f494d8dc5bcde091547d0050e957d"
relatedReport: reports/2026-09-26-workflow-manager-flows-as-executable-config.md
tags: [conveyor, daemons, workflow, flows, decision, decision-prep]
relatedTo: ["4120", "3931", "4220", "3031"]
---

# Workflow manager: flows as executable configuration

Target (operator, 2026-09-26): migrate ALL flow-like conveyor code to declared workflow configuration — every daemon, pass and dispatch lifecycle executes from a declared flow; only step logic (classifiers, gates, effects) stays in code the config calls. Prepared: five forks with bold defaults (no server — an in-repo interpreter on declared operations + #4120 jobs; flow state derived each tick, not stored; ordered classifier guards with closed outcomes; engine hosted per daemon; the rebuild flow stays code-driven in permanent shadow), four ratify lines, and a first slice (review) with acceptance criteria. Grounded in /research/conveyor-workflow-manager/.

Operator, 2026-09-26, verbatim: *"The idea would be to migrate all flow like code to it"* and *"Eventually I
wonder if having a workflow manager where flow are pure configuration which would allow for graphs to be
generated, inspected, etc would not be a good idea"*.

**This card does not ask whether to migrate; it asks how.** No executable flow engine exists yet. The five
forks below are grounded in a prior-art survey published as
[/research/conveyor-workflow-manager/](/research/conveyor-workflow-manager/) (session report linked as
`relatedReport`), and each carries a recommended default in **bold**.

**Prep history.** The card was filed with three forks (engine, config↔code boundary, migration safety). The
survey added the host fork and dissolved "migration safety" into ratify lines. One adversarial skeptic round
and a fresh-context two-confusion screen then ran. They found two forks hidden inside the draft: where flow
state lives (the draft stored it; the current code re-derives it on purpose) and how the rebuild flow is run
(the draft's "last-known-good engine" rule does not match how daemons reload). Both are now forks. Fork 1 was
re-layered to observable rules, with the interpreter choice moved into the slice. Fork 3 gained ordered
evaluation and a limit on `otherwise`. Ratify 3 was tightened: all nine flows would have passed it as drafted.
Two citations were downgraded, and the statute collisions are reconciled in the drafted text. A second, fresh
skeptic and screen then attacked the two new forks. Fork 2's deadlines were re-keyed to observed evidence, and
Fork 5's shadow was isolated from the rebuild. Each fork records what changed.

## Ratification

Operator delegated (R939, 2026-11-15 08:45 ET 'I delegate to you'); orchestrator ratified the (a) defaults; consistent with epic #5452 N2 (no durable per-PR workflow engine).

- Fork 1: (a) in-repo engine over the declared-operations engine and #4120 jobs.
- Fork 2: (a) state derived each tick; the record keeps only what cannot be re-observed.
- Fork 3: (a) classifier guards with closed outcomes, ordered first match, no expressions.
- Fork 4: (a) a library inside the daemon that owns each state.
- Fork 5: (a) rebuild flow stays code-driven; its flow file stays in permanent shadow.

Codified in `we:docs/agent/platform-decisions.md` as #conveyor-flows-executable-config (the proposed text, verbatim).

## Axes

- **Engine** — what executes a flow. Today: nothing; `we:scripts/conveyor/flows/` describes nine flows (5,209
  lines of JSON) and `we:scripts/conveyor/flows/flow-model.mjs` checks them (`checkFlow`, line 145;
  must-provided facts, `guaranteedFacts`, line 86). The nearest engine is the declared-operations engine,
  `we:scripts/operations/engine.mjs` — pure (`startRun` 135, `advance` 376, no `node:` imports), four closed step
  kinds, suspend/resume, effects keyed by run + step — but it runs **linear** operations: a cursor over ordered
  steps, no graph, no timers, no retry caps, no owners. Durability for slow steps is the ratified #4120 job model
  ([#daemon-jobs](/docs/agent/platform-decisions/#daemon-jobs)).
- **State** — where "which state is PR 2744 in" lives. Today it is re-derived every tick: `planReconcile`
  (`we:scripts/conveyor/reconcile-core.mjs` 781–1320) reads PR labels, comments, agent listings and job records,
  and its attempt counts come from PR comments — *"a cap that a restart can reset is not a cap"* (757–759).
- **Config ↔ code boundary** — what a flow file may say. Today's flow files carry states, transitions (free-text
  `on:`), steps (free-text `does:`), facts. Nothing binds a step to code.
- **Host** — which process runs the engine. Today each daemon owns its loop:
  `we:skills-src/conveyor/review-daemon.mjs` (`runDaemonLoop` 122, 120 s tick), the fix daemon, the pass daemon,
  the drain daemon (`plateau:tools/drain-daemon/`, which shells WE scripts), the runner
  (`we:skills-src/conveyor/runner.mjs`).
- **Bootstrap** — the daemon-rebuild flow (`we:scripts/lib/daemon-rebuild.mjs` and neighbours) updates the code
  the engine itself runs from.

## Recommended path at a glance

| Fork | Recommended default | Main alternative | Confidence |
|---|---|---|---|
| Fork 1 — engine | **(a) no always-running server on the critical path: an in-repo engine over the declared-operations engine and #4120 jobs, instance records inspectable and restart-safe, graphs drawn from the files that execute** | (b) a durable-execution server (Temporal / Restate / Inngest) | med-high |
| Fork 2 — flow state | **(a) derived each tick from live observations; the record keeps only what cannot be re-observed (deadlines, job handles, a transition log); counts come from their durable sources** | (b) the stored instance record is the truth | high |
| Fork 3 — config ↔ code boundary | **(a) classifier guards with closed outcomes, transitions evaluated in order, first match wins; `otherwise` only to an escalation or failure state; no expressions in config** | (b) a small expression language in config (CEL / JSONLogic / jq) | high |
| Fork 4 — engine host | **(a) a library inside the daemon that owns each state; hand-offs travel through live state; one shared record layout gives the global view** | (b) one central workflow daemon hosting every flow | med |
| Fork 5 — bootstrap | **(a) the daemon-rebuild flow stays driven by its code, with its flow file in permanent `shadow` (validated, diffed, drawn, never driving)** | (b) the rebuild flow runs on the engine; an engine regression is undone by the outside overlay rollback | med |

## Fork 1 — What kind of engine executes a flow?

Why this is a fork: a flow has exactly one executor on the critical path; an always-running server and
in-daemon execution cannot both be it. Describe-only (d) is the excluded branch for the operator's target: code
stays the executor, the description drifts, and nothing forces the two to agree.

The rule is about what the operator and the other daemons can observe: **no extra always-running process on the
critical path; every flow instance's state is in inspectable records that survive a daemon restart; the graphs
are drawn from the files that actually execute.**

- **(a) No server: an in-repo engine over the declared-operations engine and #4120 jobs.** Each state's actions
  are declared-operation steps (`compute` / `judge` / `confirm` / `effect`); a slow action is a #4120 job;
  waits, timeouts and retry caps are evaluated from the flow file against the clock the caller passes in, so a
  timer is a record field, not an in-memory `setTimeout`, and survives the restart between ticks. *For:* the
  native-first default (`we:docs/agent/conventions.md`; memory rule 75 — a library or server is opt-in when
  clearly better); no new process or database; reuses the run store, resume, call log and the ratified job model;
  the checker is the engine's own admission test. *Against:* we maintain a small workflow engine. Crash recovery
  and job handles are #4120's, so the new code is a transition function plus a loader.
- (b) A durable-execution server (Temporal; lighter: Restate single binary, Inngest single binary with SQLite,
  DBOS as a Postgres/SQLite library). *For:* timers, retries, history, replay and a UI are solved and
  battle-tested. *Rejected:* (1) a server becomes the critical path of every daemon on one Mac. That is the
  failure class of 2026-09-26: one component that must stay alive for anything to move. (2) All four are
  **code-first**. The graph is implicit in functions, so "pure configuration, graphs generated" needs our own
  DSL and interpreter on top anyway, which is (a) plus a server. (3) History in a vendor format, harder in CI
  and on a second host.
- (d) Stay describe-only. *Rejected* above.

*Build detail, not part of the rule (decided in the review slice):* the interpreter is a pure
`advanceFlow(instance, { now, observations })` in `we:scripts/conveyor/flows/`, with the operations engine's
discipline (no io, one call = one transition, fail-closed). An in-process statechart library (XState v5 with
persisted snapshots) was considered and not chosen. Its timers are in-memory, so durability, owners, fact probes
and idempotent effects would still be ours. It stays available as an export target (FUI's workflow-engine block
already ships `toXStateConfig`).

Skeptic: SURVIVES-WITH-AMENDMENT → the draft's instance record stored state, history and attempt counters as
the truth, which duplicates state the current code re-derives on purpose. Split out as Fork 2. The
`#native-first-baseline` citation was dropped: it is a standards-level polyfill floor and does not reach tooling.

Screen: flagged(impl) → the draft ruled on "a pure in-repo interpreter" (invisible to consumers if records are
the same). Re-layered: the rule is now observable (no server, restart-safe inspectable records, graphs from the
executing files); the interpreter and XState are a build detail in the slice.

## Fork 2 — Where does a flow instance's state live?

Why this is a fork: one PR's review state cannot have two sources of truth. A stored record that is the truth
drifts whenever something outside the conveyor changes the PR (a human `/review`, the drain, GitHub closing a
stacked PR). A state derived each tick cannot drift, but it cannot hold a deadline either. As the source of
truth the two cannot coexist; the open question is which one wins where they overlap.

- **(a) Derived each tick; the record keeps only what cannot be re-observed.** Each tick, the owning daemon
  gathers observations (PR labels and comments, agent listing, #4120 job records) and the flow's guards classify
  the subject into its current state. The instance record stores only: deadlines (when a wait's timeout was
  armed), job handles, and a transition log for audit and graphs. A deadline is keyed to the **observation that
  opened the state** (a job's start, a label or comment timestamp) and is dropped when that evidence changes.
  Where the evidence already carries a start time, as #4120 job records do, the deadline is read from it, not
  stored. The log is audit only. The engine never reads it to classify; when the derived state differs from the
  log tail, the derived state wins and a transition is appended. Retry counts come from their durable source.
  That is PR comments for review/fix rounds (`countRearmComments`, as today) and the #daemon-jobs attempt count
  for job-backed steps, never a counter in the instance record. *For:* keeps today's deliberate design
  (`we:scripts/conveyor/reconcile-core.mjs` 757–759); composes with
  [#state-lives-where-its-nature-dictates](/docs/agent/platform-decisions/#state-lives-where-its-nature-dictates)
  (PR state's home is GitHub); shadow diffs compare like with like. *Against:* each tick pays the observation
  reads it pays today; guards must be written as classifiers of observed state, not as "what happened last".
- (b) The stored instance record is the truth (Temporal-style). *Rejected:* a second source of truth for PR
  state and retry caps. It drifts on every out-of-band change and double-counts the attempts #daemon-jobs already
  caps.

```jsonc
// Fork 2 (a) — the instance record holds only what cannot be re-observed
{
  "kind": "flow-instance", "flow": "review", "flowSha": "<sha of the flow file>",
  "subject": { "pr": 2744, "repo": "chalbert/web-everything" },
  "deadlines": { "dispatching": { "from": "label review:pending @ 2026-09-26T17:40:02Z", "at": "2026-09-26T18:40:02Z" } },
  // keyed to the observation that opened the state; "reviewing"'s deadline is read from the job record's start
  "job": { "handle": "host:4812:1758909731", "op": "review-pr" },   // #daemon-jobs record
  "log": [ { "from": "dispatching", "to": "reviewing", "on": "lane-acquired", "at": "…" } ]
  // no "state", no "attempts": the state is classified from observations each tick,
  // attempts come from PR comments / the job record
}
```

Skeptic: SURVIVES-WITH-AMENDMENT (second, fresh skeptic) → "reviewing" is classifiable from a live job record,
as `planReconcile` does today. But the draft's "deadline armed on entry" needed the engine to know it had just
entered a state, which only the log tail could say, so the log silently became stored state. Deadlines are now
keyed to the observation that opened the state, and the log is never read to classify. The stored-truth branch
is the one `we:scripts/conveyor/reconcile-core.mjs` 757–759 already rejects.

Screen: clear (fresh-context) — the record layout is what the health daemon, `live-state` and `/wip` read, and
stored-vs-derived decides whether drift after a human `/review` is visible: merit, not priority.

## Fork 3 — What may a flow file say, and what stays code?

Why this is a fork: a flow file either admits expressions or it does not. Once it does, logic moves into strings
where tests, declared reads and the outcome check cannot reach it, so both branches cannot be the rule.

- **(a) Classifier guards with closed outcomes; ordered first match; no expressions.** Config owns states,
  transitions, owners, waits and timeouts, retry caps, escalation, assumed/provided facts and hand-offs. Code owns
  **guards**, **judges**, **effects** and **fact probes**, each a declared operation with typed input and output.
  A guard is a `compute` step that classifies observations into one value of a declared enum. A decision with
  several conditions is **one** classifier with a composite enum (`review.classifyOwed` →
  `auth-broken | clone-stale | cap-exhausted | dispatchable`), not a chain of boolean guards. Transitions are
  evaluated **in declared order, first match wins**, and the checker reports unreachable transitions. The checker
  requires every outcome of each guard a state uses to have a transition **before** `otherwise` is considered.
  `otherwise` may target only an escalation or failure state, or carry an acknowledged card. So "accepted + red
  CI → nothing owed" is a load-time error, not a silent fall-through. *For:* static checking, exhaustiveness,
  logic stays under tests. *Against:* classifier enums must be designed. They are mostly the phases
  `planReconcile` already computes (`we:scripts/conveyor/reconcile-core.mjs` 736–745), now named.
- (b) A small expression language in config (CEL, JSONLogic, jq, or Step Functions-style Choice rules).
  *Rejected:* GitHub Actions `${{ }}` and Serverless Workflow's jq show where it ends. The logic that failed today
  would move into strings the checker cannot type or test.
- (c) Code-first flows with a derived description (Temporal's model). *Rejected:* it reverses the source of
  truth; the operator asked for flows as configuration.

```jsonc
// Fork 3 (a) — review-owed, executable
{
  "id": "review-owed", "owner": "review-daemon",
  "do": [ { "guard": "review.classifyOwed" } ],   // compute op → auth-broken | clone-stale | cap-exhausted | dispatchable
  "transitions": [
    { "when": { "guard": "review.classifyOwed", "is": "auth-broken" },   "to": "claude-auth-paused" },
    { "when": { "guard": "review.classifyOwed", "is": "clone-stale" },   "to": "stale-clone-refused" },
    { "when": { "guard": "review.classifyOwed", "is": "cap-exhausted" }, "to": "round-cap-exhausted" },
    { "when": { "guard": "review.classifyOwed", "is": "dispatchable" },  "to": "dispatching" }
  ]                                               // total over the enum: no otherwise needed
}
// Fork 3 (b) — rejected: logic in a string
// { "when": "${{ pr.labels contains 'review:human' && checks.test != 'green' }}", "to": "..." }
```

Skeptic: SURVIVES-WITH-AMENDMENT → the draft's own example ended in a catch-all `otherwise`. That made every
state trivially total, so the outcome check could not catch what it promised. The draft also chained boolean
guards in hidden order. Now: ordered first match, unreachable-transition check, `otherwise` limited to
escalation or failure, and composite classifiers instead of chains.

Screen: clear.

## Fork 4 — Which process runs the engine?

Why this is a fork: a shared engine process whose failure stops unrelated flows breaks the per-daemon failure
domains the conveyor runs on today. Branch (b) is excluded on that merit, not because a mix is impossible.

- **(a) A library inside the daemon that owns each state.** The writer of an instance is the owner named on
  its **current state**, not the owner of the flow. A hand-off (`@fix`, `@drain-land`, ten of them across the
  nine flows) is never a write into another flow's records. The receiving host sees it in live state (a label, a
  job record) on its next tick, which Fork 2 (a) makes natural. All records share one layout under the pinned
  state root, so the health daemon, `live-state` and Plateau `/wip` (#3931) read every flow's state without a
  central process. Flows whose states are owned by agent sessions or ad-hoc callers (lane-lifecycle, parts of
  build-dispatch and fix) migrate only after a slice names the host for those states. *For:* one broken flow or
  daemon does not stop the others. *Against:* there is no single engine to ask; the global view is a read over
  records.
- (b) One central workflow daemon hosting every flow. *For:* one place for scheduling and a live API.
  *Rejected:* one crash, bad rebuild or held lock stops every flow at once. That is the 2026-09-26 12:49 stall,
  when every daemon refused work because one rebuild path was broken, made general.

Skeptic: SURVIVES-WITH-AMENDMENT → the draft said "the daemon that owns each flow", but flow files name
per-state owners (sessions, "the acquiring caller", two daemons for rebuild), and hand-offs had no mechanism.
Amended to per-state writers and hand-off through live state. The skeptic also proposed this was settled by
`#conveyor-orchestration-mechanics-not-per-lane-agent` clause 3. That was not taken: that clause defers an **LLM
supervisor agent**, not a mechanical host, so it does not reach this question.

Screen: clear on merit → the "why this is a fork" line was rewritten to name the excluded branch (a shared
failure domain) instead of "one writer per instance", which a mixed layout would also satisfy.

## Fork 5 — What runs the flow that updates the engine?

Why this is a fork: the daemon-rebuild flow deploys the engine's own fixes. If the engine drives it, an engine
bug that only shows at run time can block the deploy of its own fix. If code drives it, "all flows execute from
config" has one exception. The two cannot coexist: one flow is either engine-driven or not.

- **(a) The rebuild flow stays driven by its code; its flow file runs in permanent `shadow`.** The engine
  loads, validates, diffs and draws `daemon-rebuild` like every other flow, but never drives it. That is the one
  bootstrap exception, like a bootloader, and it is written into the rule. The candidate's engine and flow files
  must also pass load validation inside the live smoke before adoption. Shadow evaluation of daemon-rebuild runs
  **after** the rebuild step, behind a dynamic import, a try/catch and a time bound, so a shadow crash or hang can
  never delay or stop the rebuild. *For:* a bad engine can never stop its own fix from deploying; the flow is
  still checked and inspectable; it costs nothing extra, because Ratify 1 already keeps every old code path.
  *Against:* one flow's code and file can drift. The shadow diff is the guard, and a diff is a health sign.
- (b) The rebuild flow runs on the engine like the others. A thrown engine failure falls back through Ratify 1,
  and the live smoke already validates the candidate's engine and flows, so (b)'s remaining risk is narrow. It is
  a **valid-but-wrong** transition at run time that silently stops adoption. The outside overlay rollback of
  [#resident-daemon-reload-lifecycle](/docs/agent/platform-decisions/#resident-daemon-reload-lifecycle) clause 5
  (d) only removes an overlay. *For:* no exception. *Rejected as default:* for that narrow case, an engine bug
  that reached `main` has no path back except a human. Only (a) keeps the rebuild independent of engine
  behaviour.
- (c) Run the rebuild as a #daemon-jobs job from a pinned code snapshot. A snapshot would be a real last-known-good
  isolation. *Rejected on precedent, not merit:* the rebuild changes the daemon clone, so it is a `mutates-tree`
  job, and #daemon-jobs Fork 2 (c) runs that kind in its own working tree, not a pinned snapshot.

Skeptic: born from the skeptic round, which REFUTED the draft ratify line "the rebuild flow is executed by the
running last-known-good engine". After adoption the candidate *is* the running engine
(#resident-daemon-reload-lifecycle clauses 1 and 4), so no older engine exists. It named (a)–(c) as the real
options. A second, fresh skeptic then attacked (a): SURVIVES-WITH-AMENDMENT. (b)'s rejection was overstated,
since Ratify 1 and the smoke already cover thrown and load-time failures, so it is narrowed to valid-but-wrong
transitions. Shadow is isolated so it cannot crash or hang the rebuild. (c) is rejected on precedent, not merit.

Screen: clear (fresh-context) — whether an engine bug can block the deploy of its own fix is visible to the
operator; the branches differ on failure isolation, not scheduling.

## Ratify (settled by precedent — not forks)

1. **Every migrated flow keeps its old path behind a per-flow switch: `off | shadow | on`.** An engine
   failure (load or validation failure, a thrown transition) falls back to the old path for that flow and
   notifies the operator. A **failed fact probe inside a valid run** is flow behaviour, not an engine failure:
   it takes the step's `onFailure` state with reason `assumption-failed:<kind>:<name>`. The fallback respects
   live job records (it never re-dispatches work a live engine-started job holds). **A flow that writes `main`
   has no automatic fallback:** it fails closed and alerts, per #daemon-jobs ("writers to `main` … no unlocked
   fallback"). *Precedent:* the operator's ruling of 2026-09-26 11:47 (a failed update falls back to the last
   working version; built in PR #2739) and the #4120 prep's "adoption behind a per-kind switch". Both are
   operator rulings not yet codified in `we:docs/agent/platform-decisions.md`; the codified text below carries
   them.
2. **Cross-repo hosts shell the WE engine; nothing is vendored.** The drain daemon
   (`plateau:tools/drain-daemon/`) already keeps its logic in `we:scripts` and schedules WE scripts. Its flow
   runs the same way. *Precedent:*
   [#deterministic-core-thin-judgment](/docs/agent/platform-decisions/#deterministic-core-thin-judgment) clause 3.
3. **The flow checker is the engine's admission test, with no waivers for the dangerous rules.** The engine
   refuses to load a flow with any unacknowledged finding. An executable flow (switch `shadow` or `on`) may **not**
   carry acknowledgements for `unbounded-wait`, `uncapped-retry` or `no-owner`. Each must be bound (a timeout, a
   cap) or routed to an escalation state first. An intentional human wait such as `human-hold` gets a timeout
   that re-escalates. Graphs are drawn from the files that execute, so there is one description. *Precedent:*
   the operator's "failures improve the product" rule. Today all 57 findings are acknowledged, so an ack-tolerant
   gate would admit every flow unchanged.
4. **No new step kinds; fact probes are `compute` steps.** A state's actions are `compute` / `judge` /
   `confirm` / `effect`. A fact probe is a `compute` over observations the host reads (is `gh` on PATH, is the
   cwd the lane, is the login valid). A wait, timeout or retry cap is a state property the engine evaluates, not
   a step. *Extends* [#operations-declared-once-callers-generated](/docs/agent/platform-decisions/#operations-declared-once-callers-generated)
   clause 2 from one operation to a lifecycle. That anchor is scoped to one operation, so this is stated as new
   law in the codified text, not claimed as already settled.

## Supported by default (not forks)

- **Shadow before cut-over.** In `shadow`, the engine classifies every instance from the same observations as
  the old path and records the diff; it acts on nothing. Cut-over once every diff is explained.
- **Vocabulary aligned with the Workflow Protocol / SCXML** (state, transition, guard, final, on-entry); conveyor
  fields (owner, wait, retries, escalation, assumes/provides) are a declared extension. The
  [Workflow Protocol](/projects/webworkflows/) is supporting context for naming, not authority: its scope is UX
  step-intents. Export to its graph or to XState config is a projection.
- **Placement.** The engine is conveyor tooling in `we:scripts/`, like the operations engine. It is not an
  implementation of the Workflow Protocol standard.
- **Migration order** (sequencing, not merit): review → fix → ci-heal → conflict → session-cleanup →
  health-watch → lane lifecycle and build dispatch (after their session-owned states have a host, Fork 4) →
  drain / land last (it writes `main`). daemon-rebuild stays in shadow (Fork 5). Each old loop is retired by
  its own card after **14 days** on `on` with zero fallback uses. The number is set here and can be amended at
  ratify.
- **Plateau view** of flows and live instances (#3931) reads the instance records.

## First executable slice — review (proposed child, filed at ratify)

Review goes first. It has the smallest blast radius (labels and comments, never writes `main`). It is already a
#4120 job (`we:scripts/operations/review-job.mjs`, old path behind `WE_REVIEW_DISPATCH_MODE`, line 102). It is
already built on a declared operation (`review-pr`, `we:scripts/operations/review-pr.mjs`). And all its states are
owned by the review daemon or the review job, so Fork 4's host is known.

**Predicted scope:** `we:scripts/conveyor/flows/`, `we:skills-src/conveyor/review-daemon.mjs`,
`we:scripts/operations/review-job.mjs`, `we:scripts/conveyor/reconcile-core.mjs` (classifiers extracted, not
rewritten). Size: M–L.

**What it builds.**
1. The executable flow schema (Fork 3 (a)): `do` bindings to declared operations, `when: { guard, is }`
   transitions evaluated in order, `otherwise` limited as in Fork 3. The nine describe-only files stay loadable,
   with bindings optional until a flow is migrated.
2. `advanceFlow` (Fork 1 build detail), pure, with an import-graph purity test like the operations engine's.
3. Instance records per Fork 2 (a): deadlines, job handle, log; state classified each tick; round counts from
   PR comments as today; the review-loop step runs as the existing review job.
4. The review daemon hosts the engine (Fork 4 (a)) behind `WE_FLOW_ENGINE_REVIEW=off|shadow|on`.

**How the checker becomes the validator.** `checkFlow` runs at load. An executable flow must also pass six new
rules:
- `unbound-step`: every `do` names a registered operation or guard.
- `non-total-guard`: every outcome of every guard used in a state has a transition before `otherwise`.
- `unreachable-transition`: an earlier transition in order already covers it.
- `bad-otherwise`: `otherwise` targets a non-escalation, non-failure state without an ack.
- `unprobed-fact`: a fact kind a step `assumes` has no registered probe.
- `forbidden-ack`: an ack on `unbounded-wait`, `uncapped-retry` or `no-owner` (Ratify 3).

A finding refuses the load, and the switch falls back to the old path (Ratify 1). At run time, before each step,
the engine probes the facts it assumes (`path-tool`, `cwd`, `env`, `auth`, `permission`, `lock`). A failed probe
takes the step's `onFailure` with reason `assumption-failed:<kind>:<name>`, recorded and visible, instead of a
silent stall.

**Acceptance.**
1. `we:scripts/conveyor/flows/review.flow.json` is executable and passes the checker with the six new rules.
   Its current acks (`human-hold` and `claude-auth-paused` unbounded waits, `round-cap-exhausted`,
   `job-died-silently`) are replaced by bounds or escalation routes. CI gates it.
2. `advanceFlow` imports nothing from `node:` (tested), and every transition in the review flow has a unit test.
3. **Shadow, live:** on the running review daemon, at least 50 owed-PR decisions (or 3 days, whichever is later).
   Every engine-vs-old-path diff is explained, each one either a flow fix or a filed bug card.
4. **Cut-over, live:** `on` for at least 10 real reviews through the engine, covering accepted, changes and
   human-hold at least once each. Before/after evidence from the daemon log and the instance records.
5. **Fallback, live:** a deliberately invalid review flow and a thrown transition each make the daemon fall back
   to the old path within one tick, notify the operator, and keep reviewing. No PR is dispatched twice.
6. **Replay:** the regression fixtures in `we:scripts/conveyor/flows/test-fixtures/regressions.mjs` are refused
   at load. With `gh` removed from PATH or Claude logged out in a test env, the review flow lands in its named
   failure state with `assumption-failed:…`, not a crash.
7. `we:scripts/conveyor/flows/graph.mjs` draws the file that executes. The old loop is not deleted; retirement
   is its own card (14 days, zero fallbacks).

## Proposed codified text (drafted; ratify verbatim or amend)

> ### Conveyor flows are executable configuration; step logic stays code the flow calls {#conveyor-flows-executable-config}
>
> Every daemon, pass and dispatch lifecycle of the conveyor executes from a declared flow file, with no
> always-running engine process on the critical path. A flow owns its states, transitions, owners, waits and
> timeouts, retry caps, escalation, assumed and provided facts and hand-offs. Code owns guards, judges, effects
> and fact probes, each a declared operation. A guard classifies observations into one value of a closed set;
> transitions match those values in declared order; flow files hold no expressions. A flow's current state is
> derived each tick from live observations. Its record keeps only deadlines, job handles and a transition log, and
> retry counts come from their durable source. The engine runs inside the daemon that owns each state. Hand-offs
> travel through live state, and slow actions are [#daemon-jobs](#daemon-jobs) jobs. The flow checker is the
> engine's admission test. A flow with an unacknowledged finding does not load, and an executing flow may not
> waive an unbounded wait, an uncapped retry or an unowned state. Every migrated flow keeps its previous path
> behind an off / shadow / on switch and falls back to it on any engine failure. The exception is a flow that
> writes `main`: it fails closed and alerts. The daemon-rebuild flow is never driven by the engine; it runs in
> permanent shadow.
>
> This extends [#operations-declared-once-callers-generated](#operations-declared-once-callers-generated) clause 2
> from one operation to a lifecycle: no new step kinds, a fact probe is a `compute`, and a wait is a state
> property. It amends
> [#conveyor-orchestration-mechanics-not-per-lane-agent](#conveyor-orchestration-mechanics-not-per-lane-agent)
> clause 1: once build-dispatch migrates, "the tested tick-core state machine" is the build-dispatch flow file
> plus its tested guards. It composes with [#deterministic-core-thin-judgment](#deterministic-core-thin-judgment)
> (the flow file and its guards are the single-sourced deterministic core; cross-repo hosts shell it),
> [#state-lives-where-its-nature-dictates](#state-lives-where-its-nature-dictates) (PR state stays on GitHub) and
> [#daemon-jobs](#daemon-jobs). It does not relax #daemon-jobs: job attempt caps stay with the job record, and
> writers to `main` keep no unlocked fallback.

**Statute check (skeptic).** The first draft collided or overlapped five times:
1. It duplicated #daemon-jobs' attempt caps. Counts now come from their durable source.
2. It silently relaxed #daemon-jobs' "no unlocked fallback" for `main` writers. `main` writers now fail closed.
3. It left #conveyor-orchestration-mechanics clause 1's "tick-core state machine" un-amended. It is now amended
   explicitly.
4. It misread #resident-daemon-reload-lifecycle for the bootstrap. That is now Fork 5.
5. It did not cite #state-lives-where-its-nature-dictates. It is now cited.

**Citation scope.**
- `#native-first-baseline` was dropped as out of scope; it is a standards-level polyfill floor.
- `#operations-declared-once-callers-generated` is now cited as *extended*, not as settling.
- `#automated-health-daemon` is analogy only, not cited as authority for Fork 4.
- The Workflow Protocol stays naming-only.

## Residual risk

We become maintainers of a small workflow engine. Durability, handles and relaunch come from #4120, and Fork 2
keeps state where it already lives, so the new code is a classifier-driven transition function plus a loader.
But one interpreter bug can reach every migrated flow. That is why hosting is per daemon (Fork 4), every flow
has its own fallback (Ratify 1), the drain migrates last and fails closed, and the rebuild flow is never driven
(Fork 5).

Two risks remain:
- **Classifier design.** Turning `planReconcile`'s ordered decision list into closed enums is where the first
  slice can go wrong. The shadow diff (acceptance 3) measures it before anything acts.
- **Scale.** Full migration is roughly two to three months of serial work on the inventory's own sizes. Until a
  flow migrates, its describe-only file must be kept honest: a daemon PR that changes a flow edits its flow file.

Revisit Fork 1 (b) if the interpreter grows its own timer or replay subsystem beyond roughly 1.5k lines after
review and fix are migrated.

### Review jury (provisional — pre-registered #2638)

Care level: `elevated` (conveyor machinery, every daemon's lifecycle). Binds against the first slice's predicted
scope (`we:scripts/conveyor/flows/`, `we:skills-src/conveyor/review-daemon.mjs`,
`we:scripts/operations/review-job.mjs`, `we:scripts/conveyor/reconcile-core.mjs`) and is re-checked against the
real diff at PR open.

| juror | lens | grounding method | pre-registered expectation |
| --- | --- | --- | --- |
| correctness#1 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. |
| security#1 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. |
| simplicity#1 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| standards-conformance#1 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| claim-accuracy#1 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |

---

## Context

### Why (evidence, 2026-09-26)

Most daemon breaks on 2026-09-26 were knock-on effects on a later step of a flow:
- cwd moved to scratch in #2701 → lane edit permission lost;
- the off-lock smoke in #2731 → candidate env stripped;
- a retargeted stacked PR → CI never re-ran;
- plus states with no owner and waits with no bound.

Replayed, the 4220 checker catches 6 of today's 7 breaks. It misses the App-auth misread: a wrong answer
inside one check, which only a unit test or a runtime probe can catch.

The checker's 57 findings on #2744 are exactly what an executing engine must not waive:
- 21 unbounded waits
- 13 uncapped retries
- 11 silent failures
- 5 unowned states
- 5 unprovided assumptions
- 2 failures with no exit

Full table in the report.

### Migration inventory (every flow-like module on main at 91cc453e4)

| Module (today) | Lines | Target flow | Rough size |
|---|---|---|---|
| `we:scripts/conveyor/tick-core.mjs` (planTick: five dispatch lists, admission holds) | 1966 | build-dispatch (+ admission sub-flow) | L |
| `we:skills-src/conveyor/runner.mjs` + `we:skills-src/conveyor/supervisor.mjs` (headless runner, supervision) | 736 + 557 | build-dispatch (engine host) | M |
| `we:scripts/conveyor/reconcile-core.mjs` routing + `we:scripts/conveyor/reconcile-pass.mjs` | 1327 + 412 | fix / ci-heal / conflict routing table | L |
| `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs` + `we:scripts/conveyor/reconcile-fix-dispatch.mjs` | 691 + 1171 | fix | L |
| `we:skills-src/conveyor/review-daemon.mjs` + `we:scripts/review-runner.mjs` + review loop policy | 553 + 335 + 485 | review | M (first to migrate) |
| `we:skills-src/conveyor/pass-daemon.mjs` passes (lease-reaper, health-watch, merge-orphan-sweep, stuck-pr-watch, conflict watch) | 277 host | one flow per pass | S each |
| `we:scripts/conveyor/ci-red-recovery-watch.mjs`, `we:scripts/conveyor/ci-queue-watch.mjs`, `we:scripts/conveyor/ci-heal-mark.mjs`, `we:scripts/conveyor/stuck-pr-watch.mjs` | ~1700 | ci-heal | M |
| `we:scripts/conveyor/parked-pr-conflict-watch.mjs` + conflict marks | ~1900 | conflict | M |
| `we:scripts/merge-ai-prs.mjs` + `we:scripts/lane-drain.mjs` + `we:scripts/pr-land.mjs` + the plateau drain daemon (`plateau:tools/drain-daemon/`, ~4300) | 5439 + 1260 + 1321 | drain-land | XL (last) |
| `we:scripts/lib/daemon-rebuild.mjs`, `we:scripts/lib/daemon-self-sync.mjs`, `we:scripts/lib/daemon-overlays.mjs`, `we:scripts/lib/daemon-live-smoke.mjs`, `we:scripts/lib/daemon-clone-lock.mjs` | ~3400 | daemon-rebuild | L (permanent shadow: Fork 5) |
| `we:scripts/conveyor/session-reaper.mjs`, `we:scripts/conveyor/hung-session.mjs`, dispatch-scratch reap | ~2500 | session-cleanup | M |
| `we:scripts/lane-pool.mjs` + `we:scripts/lib/lane-lease.mjs` + `we:scripts/prune-landed-lanes.mjs` + `we:scripts/conveyor/lease-reaper.mjs` | ~5100 | lane-lifecycle | L (host first: Fork 4) |
| `we:scripts/conveyor/health-watch.mjs` + `we:scripts/conveyor/health-watch-core.mjs` (+ health signs) | ~1200 | health-watch (reads the other flows' instance records) | M |

Sizes: S < 1 day, M 1–3 days, L ~1 week, XL > 1 week, each including shadow mode.

## Done when

1. **Ruled.** The operator rules the five forks. The rule is codified in `we:docs/agent/platform-decisions.md`
   and `codifiedIn` is set.
2. **Sliced.** The review slice above is filed as a child with its predicted scope. Then one child per flow in
   the migration order, each behind its switch, plus the Plateau view under #3931.
