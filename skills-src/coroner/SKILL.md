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
    `escalated`, `no-op`, `stopped-without-outcome`, `other`) plus `rounds` per PR.
  - `builderLaunches`: from the build-dispatch tick rows: `launched`, `launch-not-confirmed`, `failed`,
    `repeated-same-card`.
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
