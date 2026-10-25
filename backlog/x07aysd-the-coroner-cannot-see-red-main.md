---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# The coroner cannot see red main

[held entry 305] (coroner-redmain 2026-10-14, held) The coroner cannot see red main. The extractor reads only PR CI runs. It counts every cancelled run as cancelled-superseded, but 28a7885f1's run was cancelled because soak-shard (3) hit the 15-min job timeout ("exceeded the maximum execution time"), which is a hang, not a supersede. daemonErrors.smokeFailures = 0 while health-watch held rebuilds on smoke-env-timeout. Tonight's red-main post-mortem had to be rebuilt by hand from 4 logs. Fix idea: add a redMain section to we:coroner-extract.mjs. Per episode it reports: first red run, health-watch open (detection lag), owner dispatch, owner PR opened/merged, drain hold span and PRs held, merge groups ejected, fixer refusals for fix PRs, and the green run (minutes for each). Split cancelled runs into job-timeout (from the job annotation) and superseded. Count smoke-env-timeout / daemon-held-on-last-good rows. Evidence: run 38517780758 attempt 1 (job 115704430831 annotation); coroner run 2026-10-14 (--no-save) errorRates.ci.superseded 19/19 "cancelled-superseded". Scope: we:scripts/operations/coroner-extract.mjs (+ a red-main helper). Size 3.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
