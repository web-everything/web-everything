---
name: coroner
description: Post-mortem sweep of conveyor sessions to find delivery friction. Runs the deterministic extractor for the numbers, then ranks frictions, marks each NEW or COVERED-BY-<id>, and appends only the NEW ones to the held cards list. Use when the operator asks for a "coroner sweep", "post-mortem of the conveyor", "where did the sessions lose time", or runs /coroner.
---

# Coroner sweep

The numbers come from a script, never from throwaway code. Your job is the judgment part.

## 1. Extract

```bash
node scripts/operations/coroner-extract.mjs --since=<ISO|last> --json > "$SCRATCH/coroner.json"
```

- `--since=last` starts where the previous run ended (state file: `WE_CORONER_STATE`, default
  `~/workspace/.operations/state/coroner-last.json`). The first run needs an ISO time. Add `--no-save` for a dry run.
- Reads are bounded (byte caps per transcript and per log tail). Paths come from `WE_CORONER_*` env vars; the defaults
  are documented in the script header. Do not read whole transcripts or logs yourself; if a number needs
  evidence, tail a bounded window (`tail -c 200000`) of the named file.
- **Error rates come first** (`errorRates` is the first key of the JSON and the first rows of the table). Each metric is
  `{ count, total, pct, basis, causes: { <cause>: { count, pct, minutes?, examples: [{ ref, at }] } } }` with at most 2
  examples (PR / session / card / sha plus ISO time) per cause:
  - `gateRuns`: local gate attempts. Red split into `in-diff-real-failure`, `flaky-outside-diff` and
    `still-red-after-isolated-retry` (isolated-retry verdicts), `vitest-timeout`, `verify-wait-timeout`,
    `killed-superseded` (verify-daemon). Lane markers keep only each lane's last two runs, so this is a sample.
  - `ci`: PR workflow runs from `gh` (bounded: 5 run pages, 40 job lookups). Red by cause class
    (`real-code-defect`, `soak-scenario`, `infra`), only the latest run per PR head and workflow, with `superseded` (cancelled), `flakyRecovered` and `awaitingReview` (review-gate, by design) reported apart and `byCheck`
    (test-shard, soak-shard, daemon-soak, smoke, review-gate, CodeQL). `WE_CORONER_NO_CI=1` skips gh.
  - `fixSessions`: fix and ci-heal sessions by outcome (`pushed`, `gate-red-not-pushed`, `load-flake-hold`, `blocked`,
    `escalated`, `no-op`, `pushed-by-harness` (stopped, then the harness pushed the verified fix), `handed-to-harness`
    (waiting on the harness), `stopped-without-outcome`, `other`) plus `rounds` per PR.
  - `builderLaunches`: from the build-dispatch tick rows: `launched`, `launch-not-confirmed`, `failed`,
    `repeated-same-card`. Prepare failures count once per attempt (card + attempt id), never once per tick.
  - `frictions` (card 130): per-session transcript friction from a bounded tail read (`WE_CORONER_FRICTION_TAIL`, default
    2 MiB; Claude `linkScanPath`, Codex rollouts joined to `codex-delivery-threads`, agy logs), grouped by kind x executor
    (`byKindExecutor`) and again per PR kind (`byPrKind.code` / `card-only`). Signals: tool denials, guard blocks
    (`Blocked:`), permission-denied, sandbox EPERM (`headline.<executor>.sandboxEpermBlocked` = builds blocked),
    lane failures (`lane-already-leased`, `lane-acquire-failed`), re-runs, and minutes between lane acquire, first edit,
    verify request, verify verdict, push and PR open, plus the worker's own final line (redacted). `buildOutcomes`: the
    recorded result of each build dispatch run by kind x executor (`orphan-released` rows predate the settle fix).
  - `mergeConflicts`: conflict events per PR opened (newly CONFLICTING PRs, conflict-fix sessions and rounds, mechanical
    rebases, drain overlap-yield and scope-overlap waits), with minutes and `beforeAfter` the scoping cutoff
    (2026-10-06 19:00Z, override `WE_CORONER_SCOPING_CUTOFF`). Always state the before/after verdict.
  - `byKind`: the per-PR metrics (`ci`, `fixSessions` + rounds, `mergeConflicts`, `timeToMerge`, `prsOpened`) split into
    `card-only` (every changed path under `backlog/`, the `scripts/ci-card-only.mjs` rule) and `code` PRs, and
    `builderLaunches.byKind` (`build`, `prevention-card`, `prepare`). Card-only work is a different difficulty:
    always show both columns and never blend them in a ranking or a conclusion.
  - `daemonErrors`: `smokeFailures`, `concurrentMover`, `tickInProgress`, `rateLimit`, `ghReadFailures`, by daemon.
    Log lines are attributed to the nearest preceding timestamp, and "(repeated N times ...)" lines are expanded.
  Where it exists, `minutes` is time lost (marker or session duration), which is what step 2 ranks on.
- Other metrics: session minutes by kind, share inside gate commands, verify-lane median/p90, wait-timeouts, direct vitest,
  heavy slot holds by kind, marker admission wait, reaped waiters, denials by type, loops, verify-daemon
  kills/supersedes (untimestamped tail), top PRs by session time, refusal reasons and refusals by PR.

## 2. Error rates first, then rank

Open the report with the **error-rate section**: one line per metric (`count/total pct`), its causes with counts and
2 example refs each, taken straight from `errorRates`. Never recompute them by hand.

Then rank the **top 5 error causes by time lost** (`minutes`, then count). Where a cause has no `minutes`
(builder, daemon), say so and rank it by count below those that have minutes. Mark each of the 5 `NEW` or
`COVERED-BY-<id>` using step 3.

Then the wider friction list (top ~12). Rank by minutes lost, then by frequency. Each row: friction, frequency/cost, evidence (a PR, session id, lane or
log line from the JSON), likely cause. Cross-check suspicious numbers against one bounded sample before ranking.

## 2b. Change-request root causes (`changeRequests`)

`changeRequests.byKind.{code,card-only}` (from `scripts/operations/coroner-rounds.mjs`) lists, per PR opened in the window,
every **round**: one PR head that got a changes request (`review-changes`, `advisory-changes`, `referral-block`,
`operator-send-back`, or `ci-red` on a head a later head replaced). Each round has its findings (`file`, `line`, `lens`,
`claim`, `ruling`, `prevention`), its fix sessions and `minutes`, and `nextPush` (what the next push changed: files,
lines, paths; `includesMainMerge` when a main merge inflates it). Each PR has `attributes` (files/lines, subsystems,
test-to-code ratio, card size/kind, `prep` (prepared, preparedDate age, checklist, executable done-when, scope declared vs
outside/untouched), `builder` (who, executor, model), `care`, `seated` lenses, `laneBaseAgeHours`) and `correlation` is
the ranked attribute → extra-rounds table (median split for numbers, `rho` = Spearman).

Findings carry a deterministic `hint` only: `fix-introduced` (line inside the previous fix push), `re-raised` (same file
within 15 lines of an earlier finding), `later-round-find` (file in the original diff, first raised after round 1),
`flaky-infra` / `gate-missed-catching-test` (CI rounds). Round-1 findings have no hint. **Your judgment step:** give every
finding one root cause, confirming or overriding the hint:

| cause | when |
|---|---|
| `checklist-lacked-requirement` | the card/prepare never asked for it (read the card's Done-when and scope) |
| `reinvented-existing-primitive` | the PR re-wrote something a shared helper already does (grep for the helper) |
| `gate-missed-catching-test` | an existing test or scan catches it, but the local gate did not run it |
| `fix-introduced` | a fix push created it |
| `later-round-find` | it was on the original code and findable in round 1 |
| `flaky-infra` | CI/host noise, not the code |
| `other` | say what (e.g. ruling churn: the same known finding re-ruled block every round) |

For each cause name the **prevention** that would have caught it before the PR (a card checklist line, a gate change,
a lint, a brief rule). Then report, with **card-only and code PRs as separate tables** (never blended):
1. counts + minutes per cause (minutes = the round's fix minutes split evenly over its findings);
2. the `correlation` table (attribute, buckets with mean extra rounds, effect, rho, n, 2 example PRs), top rows first,
   and say plainly when n is too small to trust.

## 2c. Executor comparison (`executors`)

`executors.{claude,codex,agy}` (from `scripts/operations/coroner-executors.mjs`) compares runs, tasks, rounds per task,
error rate, median/p90 minutes, tokens (codex, agy only) and tool errors. Sources, all bounded and read-only:
Codex rollouts `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (linked to a card via `codex-pilot.jsonl` threadId, else the PR
in the prompt; role from cwd `we-review-seat-*` = review) and agy stream-json transcripts
`~/.antigravity-judge-transcripts/antigravity-judge-<id>.jsonl` (review seats; the transcript carries no PR id, so tasks
are per session). Never print tokens or secrets: only counts. Use it for card 64 / agy routing; set
`WE_CORONER_NO_EXECUTORS=1` to skip.

## 3. Mark NEW vs COVERED

Compare each friction against, in this order:
1. The held list: `/Users/nicolasgilbert/workspace/.operations/handoff/cards-to-file.md` (read it all).
2. Open PRs: `gh pr list --state open --json number,title`.
3. Recent backlog cards: `ls -t backlog | head -80`, then grep for the keywords.

Label `COVERED-BY-<held item number | PR # | card id>` or `NEW`. When in doubt, a friction is covered only if the
existing item would remove this cause, not just mention the same area.

## 4. Append NEW items only

Numbering continues from the file's last item. Write with:

```bash
cd /Users/nicolasgilbert/workspace/.operations/handoff && cat >> cards-to-file.md <<'EOF2'
<N>. (coroner-<run>, held) **<one-line friction>.** <frequency, cost, window>.
    Fix idea: <change to the daemon/tooling that handles it automatically>.
    Evidence: <file/PR/session ids>. Scope: we:<paths>. Size <n>.
EOF2
```

Fixes go into the product (daemon/tooling), never a manual step for one instance. Do not file items already covered.

## 5. Report

The error-rate section first, then the top-5 causes table (cause, minutes, count, NEW/COVERED-BY), then the change-request root-cause tables and the attribute correlation table (step 2b, code and card-only apart), then one short table of the ranked frictions with the status column, the headline numbers, and the item numbers appended.
End with a list of what needs the operator's review.

Repo-only: this skill uses nothing from user-level CLAUDE.md, memory or skills. Runtime state under `~/.claude/jobs`
and `~/workspace/.operations` is read as data.

## LLM sample (card 130 S3)

`node scripts/operations/coroner-sample.mjs --hours=12` picks the worst N sessions by minutes lost (S1 signals), has a cheap
tool-free model summarise each into a schema-checked, worker-result-shaped record (outcome, blocker.kind, evidence, proposedFix),
drops invalid ones with a count, ranks blocker kinds by deterministic minutes lost, and prints the cost per run. Knob
`coroner.sampleSize` (`--sample-size`, `WE_CORONER_SAMPLE_SIZE`, default 28). Stability rule: top-5 unchanged for 3 runs halves N
(floor 5); a changed ranking returns to the large N. History: `~/workspace/.operations/metrics/perf/coroner-sample-ranking.jsonl`.
