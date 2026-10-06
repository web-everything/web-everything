---
bornAs: xx5u6zt
kind: story
size: 2
parent: "3383"
status: open
scope: ["we:.github/workflows/ci.yml", "we:scripts/ci/shard-runner-compare.mjs", "we:scripts/ci/shard-runner-compare.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-06"
preparedAgainstSha: "75c39659a06fefd7ee76fb1af223d53880109a25"
tags: []
---

# Experiment: run the CI test shards on GitHub's free Arm runners

Operator, 2026-10-03: keep standard runners (paid larger runners rejected on cost, ~$3-10k/month at ~10,000 job-minutes/day); try the free option as an experiment. Measured that day: a PR CI run took 36 min wall, of which ~10 min testing (4 test shards ~4 min each, test gate 6, smoke 2) and the rest queue wait. GitHub's ubuntu-24.04-arm runners are free on public repos. Experiment: in we:.github/workflows/ci.yml, run the test-shard matrix on ubuntu-24.04-arm behind a switch (default off, flipped on for the trial), keep every other job on ubuntu-latest. Compare shard durations, flake rate and failures over a fixed sample (e.g. 30 PR runs each way), using gh run data. Decide keep or revert from the numbers; record them on this card. Abort at once if any native dependency lacks an Arm build or results differ from x86. Done when: the comparison table (median and p90 shard minutes, failures, flakes, both sides) is on this card and the switch is set to the winner.

## Done when

1. **Executable** — `node we:scripts/ci/shard-runner-compare.test.mjs`-style unit test plus the workflow-lint test: `grep -nE "^    runs-on: .*vars\.WE_SHARD_RUNNER" we:.github/workflows/ci.yml` matches exactly the `test-shard` job (no match before this lands).
2. **Comparison on the card** — the table (median and p90 shard minutes, failures, flakes, x86 vs Arm, over ~30 PR runs each) is under `## Progress`, and the variable is set to the winner.

## Design

Premise check (2026-10-06): no `ubuntu-24.04-arm` anywhere in `we:.github/workflows/` (`git log -S` finds nothing), so the goal is undelivered. The repo is public (`gh repo view` → `isPrivate:false`), so Arm runners are free. Only `test-shard` (we:.github/workflows/ci.yml:91, `runs-on: ubuntu-latest` at :94) changes. Make it `runs-on: ${{ vars.WE_SHARD_RUNNER || 'ubuntu-latest' }}`. This mirrors the existing repo-variable switch `vars.WE_MEASURE_TEST_SELECTION` (:537). The switch is default-off (unset variable means x86) and is flipped to `ubuntu-24.04-arm` by setting the repo variable, so no PR is needed to start or abort the trial. The matrix stays single-dimension (:108-115), so `strategy.job-total` stays correct. `test` (:192) and all other jobs stay on `ubuntu-latest`. Native-dependency risk: `esbuild` (we:package.json:105) and Playwright ship Arm builds, but the trial must confirm `npm ci` and the unit suite pass on Arm. Any missing Arm build or any result that differs from x86 aborts: unset the variable.

## MVP

Musts only:
- The `runs-on` switch above, default off.
- A measurement helper `we:scripts/ci/shard-runner-compare.mjs` (reads `gh run list`/`gh run view --json jobs`) that tabulates shard durations, failures and flakes per runner type from ~30 runs each, written onto this card.
- The verdict: set `WE_SHARD_RUNNER` to the winner (or leave unset).

Out of scope: moving other jobs (`soak-shard`, `smoke`) to Arm; paid larger runners (rejected on cost); changing shard count.

## Test plan

- Workflow lint test (new, or extending an existing workflow-guard test): asserts the `test-shard` job's `runs-on` references `vars.WE_SHARD_RUNNER` with an `ubuntu-latest` fallback. Fails RED today because it is the literal `ubuntu-latest`.
- Same test asserts `test`, `changes`, `daemon-soak-scope` and `soak-shard` stay on `ubuntu-latest`. This is a regression guard (already green today); it goes red if someone widens the switch.
- Same test asserts the matrix has a single `shard` axis, protecting the `job-total` divisor. Also a regression guard, not RED today.
- Measurement helper (named path `we:scripts/ci/shard-runner-compare.mjs` + unit test on canned `gh run view --json jobs` fixtures): asserts it groups shard job durations by runner label and reports median, p90, failures and flakes, where a flake is a shard that failed then passed on re-run of the same commit. RED today because the script does not exist.

## Proof plan

Confound note: `vars.*` is repo-wide, so the trial is two sequential periods, not a parallel A/B. Record run dates and queue-wait alongside shard minutes, and compare shard run time (not queue) as the primary number. Live, on a real PR run: (1) before: baseline shard times pulled with `we:scripts/ci/shard-runner-compare.mjs` from the last ~30 x86 runs (run ids listed on this card); (2) set `WE_SHARD_RUNNER=ubuntu-24.04-arm`, push a PR and show `test-shard (1..4)` landing on an Arm runner (runner name in the job log) and green; (3) after ~30 runs each side, paste the comparison table onto this card. Abort path is proven by unsetting the variable and seeing the next run go back to x86.

## Follow-ups

- Move `soak-shard` to Arm if the unit-shard trial wins.
- A periodic job that re-measures runner cost/time so the choice is not set once and forgotten.
- Document the `WE_SHARD_RUNNER` variable in the CI docs.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
