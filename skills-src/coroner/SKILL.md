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
    (`real-code-defect`, `flaky` = same head went green later, `infra-cancelled`, `soak-scenario`) and `byCheck`
    (test-shard, soak-shard, daemon-soak, smoke, review-gate, CodeQL). `WE_CORONER_NO_CI=1` skips gh.
  - `fixSessions`: fix and ci-heal sessions by outcome (`pushed`, `gate-red-not-pushed`, `load-flake-hold`, `blocked`,
    `escalated`, `no-op`, `stopped-without-outcome`, `other`) plus `rounds` per PR.
  - `builderLaunches`: from the build-dispatch tick rows: `launched`, `launch-not-confirmed`, `failed`,
    `repeated-same-card`.
  - `mergeConflicts`: conflict events per PR opened (newly CONFLICTING PRs, conflict-fix sessions and rounds, mechanical
    rebases, drain overlap-yield and scope-overlap waits), with minutes and `beforeAfter` the scoping cutoff
    (2026-10-06 19:00Z, override `WE_CORONER_SCOPING_CUTOFF`). Always state the before/after verdict.
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

The error-rate section first, then the top-5 causes table (cause, minutes, count, NEW/COVERED-BY), then one short table of the ranked frictions with the status column, the headline numbers, and the item numbers appended.
End with a list of what needs the operator's review.

Repo-only: this skill uses nothing from user-level CLAUDE.md, memory or skills. Runtime state under `~/.claude/jobs`
and `~/workspace/.operations` is read as data.
