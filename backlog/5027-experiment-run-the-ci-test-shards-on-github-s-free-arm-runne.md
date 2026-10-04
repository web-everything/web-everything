---
bornAs: xx5u6zt
kind: story
size: 2
parent: "3383"
status: open
scope: ["we:.github/workflows/ci.yml"]
dateOpened: "2026-10-03"
tags: []
---

# Experiment: run the CI test shards on GitHub's free Arm runners

Operator, 2026-10-03: keep standard runners (paid larger runners rejected on cost, ~$3-10k/month at ~10,000 job-minutes/day); try the free option as an experiment. Measured that day: a PR CI run took 36 min wall, of which ~10 min testing (4 test shards ~4 min each, test gate 6, smoke 2) and the rest queue wait. GitHub's ubuntu-24.04-arm runners are free on public repos. Experiment: in we:.github/workflows/ci.yml, run the test-shard matrix on ubuntu-24.04-arm behind a switch (default off, flipped on for the trial), keep every other job on ubuntu-latest. Compare shard durations, flake rate and failures over a fixed sample (e.g. 30 PR runs each way), using gh run data. Decide keep or revert from the numbers; record them on this card. Abort at once if any native dependency lacks an Arm build or results differ from x86. Done when: the comparison table (median and p90 shard minutes, failures, flakes, both sides) is on this card and the switch is set to the winner.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
