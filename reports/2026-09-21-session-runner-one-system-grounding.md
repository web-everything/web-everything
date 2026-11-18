# Session and runner: one system or two — grounding for #3722

**Date**: 2026-09-21. **Session**: prep-3722. **Main read at**: `8a7583b8f`. **CLI probed**: Claude Code 2.1.278.
**Point**: The code already treats the runner as a caller of shared operations and already derives most guard state. The real defects are narrower than the card says: per-checkout state files, one wrong premise about liveness, and one untested launch mode that turned out to work.

---

## Question

Should a live session and the unattended runner be one system (the session is one more caller of the same operations) or two systems that share leaf operations? Sub-questions: who owns the loop, where shared state lives, and what "a worker is alive" means.

## What the code says (read 2026-09-21)

| Claim in the card | What the code shows |
| --- | --- |
| Guards are session-ephemeral and the session re-derives them by hand | Partly stale. The build guard has a restart-surviving floor read from `claude agents` (`we:scripts/conveyor/tick-core.mjs` lines 393-418, #3403). The fix and ci-heal caps have a floor read from the PR's own re-arm comments (same file, lines 83-88, #2643 and #2666). What is still ephemeral: the in-flight fix entry, the prepare guard's pre-PR window, the watched set. |
| The queue file is per checkout | True, and so are three more stores. `we:scripts/conveyor/queue-store.mjs` line 130, `we:scripts/readiness/dispatch-pause.mjs` line 106, `we:scripts/operations/run-store.mjs` line 46 and `we:scripts/operations/completion-store.mjs` line 38 all resolve the repo root from the SCRIPT location. Run records, which the card treats as the durable fact to derive from, have the same defect. |
| The resolver only answers while a runner is live | True. `we:scripts/operations/file-item-io.mjs` lines 63-71 already asks the runner for its checkout and falls back to the caller's own file when there is none. |
| Three models decide whether a worker is alive: the listing, the lane lease pid heartbeat, the run record stamp | Wrong. The lane lease pid is dormant: it records the short-lived `acquire` CLI, not the agent (`we:scripts/lane-pool.mjs` lines 989-1000, `we:scripts/conveyor/lease-reaper.mjs` lines 58-67 and 434-444). Lease liveness is a TTL plus the session name matched against `claude agents`. The run record stamp is a cache of the listing (`we:scripts/operations/dispatch-lane-io.mjs` `stampLiveness`, line 523). Every reader shares one function, `defaultListAgents`. So there is one source, read in a few ways. |
| A session's dispatch is supervised by construction, so pause and capacity gates apply to unattended callers | Contradicted. `we:scripts/readiness/dispatch-pause.mjs` lines 1-12 says the pause stops ALL new dispatch, and the ceiling is "a STANDING ceiling the dispatcher always respects". #3720 records load 28 against the host core count on 2026-09-19, which was hand dispatch from sessions. |
| The spawn uses `--bg` and a one-shot launch is unverified | `we:scripts/operations/dispatch-lane-io.mjs` lines 1112-1121 confirm `--bg`. The one-shot launch is now verified on four axes (below). |

## Probes of `claude -p` (CLI 2.1.278, 2026-09-21, haiku, about $0.03-0.07 each)

| Probe | Result |
| --- | --- |
| Does `claude -p` exit when its turn ends? | Yes. Exit code 0 in 4 s for a one-word reply. Prints `session_id` with `--output-format json`. |
| Does it appear in `claude agents --json --all` while running? | Yes, as `kind: interactive`, `status: busy`, with a `pid`. |
| Does `-n <slug>` name it? | Yes. The row carried `name: probe-3722-x`. |
| Does it leave the listing when it exits? | Yes. After exit the listing had no row for it. |
| Can it be resumed after it exited? | Yes. `claude -p --resume <id>` returned the SAME session id and remembered the earlier essay topic. |
| Not probed | The worker permission profile and deny list under `-p`. Behaviour when the worker starts background subagents (docs say `-p` stays open, up to a 10-minute ceiling, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). A hung worker (needs a deadline). |

Two consequences: (1) the `pid` the reconcile refusal needs is present, so `liveness-unknown` goes away for these workers; (2) the reaper's absolute `kind !== 'background'` guard (`we:scripts/conveyor/session-reaper.mjs` line 140) never touches a `-p` row, which is right for a process that exits by itself but means a hung one needs its own deadline.

## Prior art (URLs fetched; inferences marked)

- **Kubernetes controllers.** "The system's behavior is level-based rather than edge-based"; status is "the most recent observations of actual state" (https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md). Reconcilers must not depend on specific events or tracked state (https://book.kubebuilder.io/reference/good-practices.html). The store adds compare-and-swap via `resourceVersion`.
- **Merge bots.** The original bors "reloads its entire state from github ... does that one thing, and exits" (https://github.com/graydon/bors). The successors kept a database and re-sync from GitHub every 15-30 minutes (rust-lang/bors, secondary source). GitHub's merge queue takes humans and bots through the same queue (https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue). Mergify and Zuul docs did not answer the state question.
- **Workflow engines.** A Temporal schedule and a manual trigger start the same workflow, and an overlap policy handles two callers at once (https://docs.temporal.io/schedule). One GitHub Actions workflow has several triggers, told apart by `github.event_name`; scheduled runs "may be delayed or dropped" (https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows). Argo Events feeds many event sources into one workflow (https://argoproj.github.io/argo-events/).
- **Liveness.** Kubernetes Leases and etcd leases detect a dead holder by a renewed timestamp (https://kubernetes.io/docs/concepts/architecture/leases/, https://etcd.io/docs/v3.5/learning/api/). A Job whose sidecar never exits never completes: the same "alive but finished" problem, fixed structurally by native sidecars that stop when the main container exits (https://kubernetes.io/docs/tutorials/configuration/pod-sidecar-containers). GitHub recommends ephemeral runners that de-register after one job (https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/autoscaling-with-self-hosted-runners).
- **Claude Code.** `claude -p` exits with code 0 on success; if a worker starts background subagents it stays open until they finish, up to a 10-minute idle ceiling (https://code.claude.com/docs/en/headless). Background sessions stay resident, and an unattached finished one is stopped by the supervisor after about an hour (https://code.claude.com/docs/en/agent-view).
- **Operator intent across checkouts.** git notes are not fetched by default and merge by hand (https://git-scm.com/docs/git-notes): the same class of problem as per-checkout files plus a sync. GitHub labels have no compare-and-swap (inference, not verified in the docs).

## What this changes about the forks

- **Fork 1 (who owns the loop)** is close to a forced invariant. Three ratified statutes already point one way (#3031, #3118 clause 2, #2701). Prior art agrees: one reconciler, many callers, the human writes intent. The arbitration question prior art raises (two callers at once) already has an answer in the code: the lane lease is an atomic O_EXCL claim, `claim` is atomic, and `dispatch-lane` refuses a second dispatch. It is only weak where its run record is per checkout, which is Fork 3.
- **Fork 2 (attended vs unattended)** did not exist in the card as a fork. It was prose ("design for them") resting on a premise the record contradicts. Prior art (Temporal, Actions) treats trigger identity as data, not a code fork.
- **Fork 3 (state home)** was reframed. "Derive, do not store" is already the pattern and needs no ruling. What is open is where the facts it leans on live. The card's default (one resolver to the live runner's checkout, else primary) fails exactly when no runner is live and needs a way to find the primary checkout from a lane clone, which the code cannot do by git. A machine-level home keyed by repo already has precedent: the lane pool and the runner lock.
- **Fork 4 (liveness)** mostly dissolves the card's worry: one source, not three models. What remains is the launch mode. Run-to-completion works on the probed axes but the prep skeptic showed it is not a flag change: the spawn is a blocking `execFileSync` with a 60-second kill (`we:scripts/operations/dispatch-lane-io.mjs:1037-1041`), the supervisor it needs is #3627's open call, `we:scripts/conveyor/lease-reaper.mjs:265` skips any session whose `kind` is not `background` (a live `-p` worker's lease would be force-released after the 10-minute grace), interactive rows carry no `id` (so `resumeSucceeded` cannot match), and the permission profile under `-p` is unprobed against a deliberate move to `--bg` for zero permission bypass (commit `9d5a8c2dd`). The default is the resident model with a completion-record and deadline reaper; run-to-completion is the named, gated target.

## Corrections the prep skeptic made to the first draft

- Pause and the lane ceiling are enforced only in the planners (`dispatchPlan`, `planTick`); no dispatch operation reads `isDispatchPaused`. "Every gate binds every caller" is therefore a build, not only a rule.
- The primary checkout can be derived from a lane clone via `.git/objects/info/alternates` (absent on shallow clones). Fork 3's reason to prefer a fixed home is the runner-down and `lsof` case.
- Seven stores, not four, resolve by script location (adds infra-blocked, the jury ledger, the red-main freeze). `we:scripts/readiness/file-locks.mjs` is a non-blocking 15-minute reservation under a per-checkout root, not a short-critical-section mutex.
- `review-dispatch` is a plain module with no run record, not a `dispatch-lane` caller.
- `defaultListAgents` is defined at `we:scripts/operations/dispatch-lane-io.mjs:1793`; `:443` is its session-id comparison.
