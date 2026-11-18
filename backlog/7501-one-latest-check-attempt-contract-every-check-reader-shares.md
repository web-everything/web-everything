---
bornAs: xlrfkwm
kind: story
size: 8
status: open
scope: ["we:scripts/lib/latest-check-attempt.mjs", "we:scripts/lib/__tests__/latest-check-attempt.test.mjs", "we:scripts/lib/rollup-collapse.mjs", "we:scripts/lib/__tests__/rollup-collapse.test.mjs", "we:scripts/lib/__tests__/fixtures/"]
dateOpened: "2026-10-30"
preparedDate: "2026-10-30"
preparedAgainstSha: "df0b3a05f2395f0a2363a935121284e5fef90fc4"
tags: []
---

# One latest-check-attempt contract every check reader shares

PR #6042 (S2 check-state predicate, R216 ranking redesign) hit a new confirmed red-team break class on every head since 88f733dc because each reader orders check attempts its own way: we:scripts/lib/rollup-collapse.mjs latestOf/latestByTime (drain), we:scripts/lib/check-state-predicate.mjs latestAttempts (PR-only, case-folds names, ranks by completion time), we:scripts/lib/red-main-quarantine-io.mjs (job run_attempt), we:scripts/operations/coroner-rounds.mjs (createdAt then runAttempt). Write ONE pure which-attempt-is-latest contract (identity, ordering, in-progress precedence, required set, gate-only checks) with a table-driven conformance suite, and point every reader at it.

## Acceptance

- [A1] **Executable — the contract.** Every row of the `BREAKS` table in `we:scripts/lib/__tests__/latest-check-attempt.test.mjs` (B1–B15 in the Test plan) passes against `selectLatestAttempts` / `summarizeChecks` in `we:scripts/lib/latest-check-attempt.mjs`. Before the build the module does not exist, so the suite fails on import; the same table run against the PR-#6042 head's `latestAttempts` fails B3, B8 and B9a.
- [A2] **Executable — drain conformance.** `rollup readers agree with the contract on every BREAKS row` in `we:scripts/lib/__tests__/rollup-collapse.test.mjs` runs each row through `collapseRollupToLatestPerName` and `latestCheckNamed` and asserts the contract's pick (B13 is contract-only: rollup rows carry no head sha, and R1's REST path already refuses a wrong head in `mergeRequiredCheckRuns`). On current main it fails B3, B7 and B14 (R1 picks a different row); after the build it passes.
- [A3] **Executable — no behaviour regression.** The existing suites that import `we:scripts/lib/rollup-collapse.mjs` or the drain's `latestRequiredCheck` / `isRequiredCheckFailed` / `isRequiredCheckPending` (R2, unedited) stay green unchanged, except for cases the Proof plan's replay lists as an intended difference (each such test edit is named in `## Progress` with its BREAKS row).
- [A4] **Executable — fail closed.** `no total order is never green` and `unknown conclusion is never green` rows (B3, B15b) return state `pending` / `unknown`; `summarizeChecks` without `requiredNames` throws `unknown-required-set`, never "all green".

## Non-goals

- [N1] Migrating the #6042 ci-heal readers (`we:scripts/conveyor/ci-heal-verdict-recheck.mjs`, `we:scripts/conveyor/ci-heal-escalation-mark.mjs`). That is the #6042 rebuild itself, done on top of this contract (Follow-up F1).
- [N2] Changing what the drain or review daemon DO with a state. This item fixes which row is "latest" and names its state; policy stays with each reader.
- [N3] The readers with their own ordering outside R1 (R14, R15, R18–R22; Follow-ups F3, F4, F7). R14/R21/R22 are already O4-conformant (within-run attempts); R15/R18/R19 are migrated later on the same `BREAKS` table.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — check names come from PR-controlled workflow files: compare exactly, never build a regex or a path from a name, never case-fold or NFKC-fold (two names that differ only by case or by an invisible character stay two checks — B8 covers case; add one zero-width-space row to B8).
2. **Truncated reads** — the contract is pure and reads no network, but `summarizeChecks` returns `unreadable` for every required name when the caller passes `truncated: true` (rollup at the 100-row cap, `we:scripts/lib/rollup-collapse.mjs#requiredCheckReadNeeded`) or `readError`; the REST re-read via `mergeRequiredCheckRuns` stays the only way out.
3. **Shared state files** — n/a: pure functions over an in-memory array; no file is read or written.
4. **Fail closed** — no total order (B3), unknown conclusion (B15b), missing required check, wrong-head-only rows, unreadable rollup: each is a named non-green state, never `green`, never silently dropped.
5. **Identity scoping** — identity is (exact name, source tier) within ONE head: rows whose `head_sha`/`headSha` differ from the caller's `headSha` are excluded and listed in `wrongHead` (B13). `run_id` / `run_attempt` are never part of identity or rank.
6. **State over time** — a re-run of any earlier run creates a new check run with a higher id, so it wins (B2/B7); an in-flight newest attempt is `pending` even when an older one completed (B9); a queued row with the zero-date `startedAt` ranks newest under O2.
7. **Who wrote it** — `review-gate` / `merge-gate` / `CodeQL` are classed by exact name AND source: a `hold-gate` row must come from this repo's own gate workflows (`workflowName` `Review gate` / `Merge gate`) and `CodeQL` from the code-scanning app; a same-named row from another workflow is class `ci` and listed in `multiSource` (B4c), so a PR cannot add a workflow job named `merge-gate` to masquerade as a hold.

## Design

### Readers today (main @ f16501bd72, plus the #6042 head e3fffe14)

Every reader below picks "the latest attempt per check" (or per workflow run) before judging it. 27 files on main, 2 more on the #6042 head. R2 also carries the indirect `latestRequiredCheck` callers (`we:scripts/conveyor/reconcile-pass.mjs:743/:822`, `we:scripts/lane-resume.mjs:436`, `we:scripts/conveyor/pr-watch.mjs:148`).

| # | Reader (file:line) | Who uses it | How it orders today |
|---|---|---|---|
| R1 | `we:scripts/lib/rollup-collapse.mjs:66` `collapseRollupToLatestPerName`, `:91` `latestCheckNamed`, `latestOf` / `latestByTime` | the shared core | group by exact `name \|\| context`; tier CheckRun > untagged > StatusContext; if EVERY row has a numeric `id` the max id wins, else greatest `completedAt` with in-flight = +Infinity, else last position for the whole group |
| R2 | `we:scripts/merge-ai-prs.mjs:460` `latestRequiredCheck`, `:488` `resolveRequiredCheck`, `:521/:533/:570` green/failed/pending, `:990` `classifyPr` | drain | R1 (`latestCheckNamed`) + REST re-read via `mergeRequiredCheckRuns` |
| R3 | `we:scripts/lib/codeql-gate.mjs:38` `failedCodeQLCheck` | drain CodeQL block | R1, then `.find` by exact `CodeQL` |
| R4 | `we:scripts/lib/merge-gate-hold-class.mjs:106` | drain / review hold class | R1, `.find` `merge-gate` |
| R5 | `we:scripts/conveyor/review-status-tag.mjs:302` | review tag | R1, `.find` `merge-gate` |
| R6 | `we:scripts/lib/review-ci-gate.mjs:24` `reviewCiGate` | review daemon | R1 + its own `statusAsCheckRow` state map + head check |
| R7 | `we:scripts/lib/review-timing.mjs:60`, `:101` | review daemon | R1 |
| R8 | `we:scripts/operations/pr-status.mjs:172-173` `reduceCheckState` | `pr-reconcile` CLI | R1 + implied-check filter; no review-hold annotation |
| R9 | `we:scripts/fetch-parked.mjs:69` | `/review` CLI | R1 |
| R10 | `we:scripts/lib/card-group.mjs:750` | combined-PR reconcile | R1 (`latestCheckNamed`) |
| R11 | `we:scripts/conveyor/reconcile-core.mjs:494/:504/:515/:541`, `we:scripts/conveyor/reconcile-pass.mjs:1350/:1359` | fix daemon reconcile | R1 |
| R12 | `we:scripts/conveyor/ci-heal-verdict-recheck.mjs:95` (main) | ci-heal | R1 |
| R13 | `we:scripts/conveyor/ci-red-recovery-watch.mjs:261`, `we:scripts/conveyor/exhausted-retry.mjs:41/:54`, `we:scripts/conveyor/fix-push-ci.mjs:33`, `we:scripts/conveyor/stale-base-refresh.mjs:160`, `we:scripts/lib/renamed-pr-refresh.mjs:32`, `we:scripts/lib/pr-state-io.mjs:124`, `we:scripts/progress-board.mjs:513`, `we:scripts/readiness/conveyor-state.mjs:213`, `we:scripts/operations/fix-run.mjs:407` | fix / rebase / boards | R1 |
| R14 | `we:scripts/lib/red-main-quarantine-io.mjs:190-196` | main quarantine (rerun-passed proof) | its own: per job `name`, max `run_attempt` within ONE run's jobs |
| R15 | `we:scripts/operations/coroner-rounds.mjs:148` `ciRounds` | coroner | its own: key `headSha\|name`, sort `createdAt` then `runAttempt`, last wins; drops `review.?gate` by case-insensitive regex |
| R16 | `we:scripts/lib/check-state-predicate.mjs` `latestAttempts` (#6042 head only) | #6042 | case-folded `name`; effective time completed > started > created; id breaks ties |
| R17 | `we:scripts/conveyor/ci-heal-verdict-recheck.mjs:89-110` `checkEvidence` (#6042 head) | #6042 ci-heal | lower-cases the name (`:96`), keeps R1's tiers, then R16 |
| R18 | `we:scripts/conveyor/main-red-recovery.mjs:352` `collapseMainCheckRunsToLatestPerName` | main red recovery | its own collapse over main's REST check-runs (snake_case), latest `updatedAt` / `completed_at` |
| R19 | `we:scripts/operations/coroner-extract.mjs:289` | coroner | same `createdAt` + `runAttempt` sort as R15, key `headSha\|name` |
| R20 | `we:scripts/conveyor/reconcile-pass.mjs:1859` | reconcile | reads `check-runs?filter=latest` itself (GitHub's own latest-per-name), paged to 30 |
| R21 | `we:scripts/operations/ci-heal-pr-dispatch.mjs:695` | ci-heal dispatch | job/run `run_attempt` of one named job (within one run) |
| R22 | `we:scripts/conveyor/ci-queue-watch.mjs:742/:798` | CI queue watch | `run_attempt` of one run vs its recorded attempt (within one run) |

So there are really six orderings: R1 (21 files ride it), R18, R15/R19, R16/R17, GitHub's `filter=latest` (R20, and R1's REST path), and within-run `run_attempt` (R14, R21, R22 — already O4-conformant). The #6042 breaks all live in the gap between R1 and R16, and R1 itself still has four holes (B3, B7, B13, B14).

### The contract (`we:scripts/lib/latest-check-attempt.mjs`, zero imports)

Identity:

- **I1 — name is exact.** `row.name || row.context` (R1's rule: an empty `name` falls through to `context`; `we:scripts/lib/review-ci-gate.mjs:24` uses `??` and moves to this), compared with `===`. No case fold, no trim, no Unicode fold. `test` and `TEST` are two checks (B8).
- **I2 — source tier** stays R1's: CheckRun > untagged > StatusContext (`rollupRowKind`, moved here and re-exported from R1). Only the best non-empty tier competes.
- **I3 — head.** With `headSha` given, a row carrying a different `head_sha` / `headSha` / `commit.oid` is excluded into `wrongHead`.
- **I4 — source** (`workflowName` / `app.slug` / `check_suite.app.slug`) is carried, not keyed. When the latest-per-source rows of one name come from more than one source, the name is listed in `multiSource` (annotation; the pick still follows O1–O3, which matches the drain today).

Ordering — one total key per name group, never mixed between rows:

- **O1 — check-run id.** `id` / `databaseId`, or the number parsed from `detailsUrl`: `/actions/runs/<runId>/job/<jobId>` yields the job id (= the check-run id); `/<owner>/<repo>/runs/<id>` (non-Actions apps) yields that id. Never reuse `checkRunIdFromUrl` in `we:scripts/lib/codeql-gate.mjs:43` for Actions URLs — its `/runs/(\d+)` match returns the workflow RUN id there, a different id space that would corrupt O1 (B16). A URL that parses to neither shape counts as no id. GitHub assigns check-run ids at creation and every re-run creates a new check run, so the highest id is the most recently created attempt, whatever its `run_id` or `run_attempt`. If EVERY row in the group has one, the max wins. Live: the #6042 rollup lists `review-gate` FAILUREs before CANCELLEDs before SUCCESSes (not creation order), and every row carries a `detailsUrl` job id — so in practice O1 decides almost every rollup group.
- **O2 — creation-side time**, only when some row lacks an id: the key is `startedAt`/`started_at`, else `createdAt`/`created_at` (StatusContext rows carry only `createdAt`), valid only after 2000-01-01; a not-completed row with no valid time is newest. If every row has a key, the greatest wins.
- **O3 — no total order.** Otherwise R1's legacy rule picks (greatest `completedAt`, in-flight newest, else last position) and the pick is reported with `orderBasis: 'legacy'`. If the group's rows disagree on state, the name is `indeterminate` and its state is forced to `pending` (never green, never red). Same-state groups keep today's answer, so the drain only changes where today's positional pick could read a stale green.
- **O4 — run_attempt and run_id never rank across runs.** `run_attempt` only orders jobs within ONE `run_id` (that is R14's rule, kept). Comparing attempt counters across runs is a contract violation (B1, B2).
- **O5 — completion time never ranks** (sole exception: the O3 legacy fallback, which only decides same-state groups). `completedAt` describes an attempt's state, not its age. Ranking by it is what hides an in-flight re-run behind an older finished attempt (B9) and what R216 asked for — see *Preparation note*.
- **O6 — ties** (equal O2 key, no ids): the non-green row wins (fail closed, B14). Today R1 keeps the later position; the replay reports every such case.

State (one table, replacing the forked ones in R1 `FAILED_CHECK_CONCLUSIONS`, R6 `statusAsCheckRow`, R16 `CHECK_STATE_TABLE`):

- Mapping is case-insensitive (rollup is upper-case, REST is lower-case; `mergeRequiredCheckRuns` emits `conclusion: null` with a lower-case `status` for an in-flight run).
- `green`: success, neutral, skipped. `red`: failure, error, timed_out, action_required, startup_failure. `cancelled`: cancelled, stale — its own state, so the drain keeps blocking it (not green, as `FAILED_CHECK_CONCLUSIONS` does today) and ci-heal can treat it as "re-run expected" without a fork. `pending`: queued, in_progress, waiting, requested, pending, expected. `unknown`: anything else, or completed with no conclusion. Legacy StatusContext `state` maps through the same table (R6's `statusAsCheckRow` moves here).
- In-progress precedence is simply "the latest attempt's own state": there is no rule where a completed older attempt beats a newer one.

Classes (who may treat a red as "not a code failure"):

- `hold-gate`: `review-gate`, `merge-gate` from this repo's gate workflows. Their red is a hold signal. `scan`: `CodeQL` from code scanning — drain-blocking under `drainBlocksOnCodeQL`, never a hold, never ci-heal. `ci`: everything else, including a same-named row from another source (edge case 7).

Summary — `summarizeChecks(rows, { requiredNames, headSha, truncated, readError })`:

- `requiredNames` is mandatory (exact names; the implied-check rule from `we:scripts/lib/required-check-implication.mjs` is applied by the caller before or via an `implied` option). Missing → throws `unknown-required-set`.
- Returns `{ latest, byState, missing, unreadable, ciRed, holdRed, scanRed, holds, gateOnlyRed, allRequiredGreen, wrongHead, indeterminate, multiSource }`. `holds` lists every `hold-gate` row with its state, so a CLI can print a review-hold note (B6). `gateOnlyRed` = `ciRed` empty and `holdRed` not empty; `scan` never counts (B5). A merge-gate red is always in `holdRed` — never dropped (B4).

### R1 becomes a thin wrapper

`collapseRollupToLatestPerName(rollup)` returns `selectLatestAttempts(rollup).rows` (same shape: one original row per name, first-seen order, nameless rows passed through 1:1). `latestCheckNamed(rollup, name)` returns `byName.get(name) ?? null`. `rollupRowKind` and `isFailedCheckRow` re-export from the contract. R1 keeps zero non-pure imports, so the read-only guarantee `we:scripts/operations/http-adapter.test.mjs` (#3036) enforces on `we:scripts/operations/pr-status.mjs` still holds. That one change moves R2–R13 (21 files) onto the contract with no edit in any of them.

### Preparation note — this departs from R216

R216 asked for ranking by "latest check-run completion time (tie-break by id)". The contract ranks by creation (check-run id) instead (O1, O5): completion time cannot order an in-flight attempt, and it lets an older long run that finished late outrank a newer short re-run. Choosing id-first is the one judgment call in this card; it is the operator's to confirm when ruling on #6042.

## MVP

Musts only:

1. `we:scripts/lib/latest-check-attempt.mjs`: `checkIdentity`, `checkRunIdOf`, `selectLatestAttempts`, `checkState`, `checkClass`, `summarizeChecks`, `STATE_TABLE`, `HOLD_GATES`, `SCAN_CHECKS`. Pure, zero imports.
2. `we:scripts/lib/__tests__/latest-check-attempt.test.mjs`: the exported `BREAKS` table (B1–B15) run with `it.each`.
3. `we:scripts/lib/rollup-collapse.mjs`: `collapseRollupToLatestPerName`, `latestCheckNamed`, `rollupRowKind`, `isFailedCheckRow`, `FAILED_CHECK_CONCLUSIONS` delegate to the contract; `latestOf` / `latestByTime` deleted.
4. `we:scripts/lib/__tests__/rollup-collapse.test.mjs`: imports `BREAKS` and asserts R1's two entry points pick the same row as the contract for every row.

`summarizeChecks` and the class split (B4–B6) are in the MVP even though no reader calls them yet: their first caller is F1, the #6042 rebuild, and the S2 breaks it must close (gate-only red, CodeQL, merge-gate discard) are summary-level, not pick-level. Without them the contract cannot be the thing #6042 is rebuilt on.

Out of the MVP (Follow-ups): F1 #6042 rebuild, F2 pure reader conformance loop beyond R1, F3 R14/R21/R22, F4 R15/R19, F5 CLI review-hold annotation, F6 the "no private ordering" guard, F7 R18 and R20.

## Test plan

One table, `BREAKS`, each row `{ id, why, rows, headSha?, requiredNames?, expect }`. Red-before reasons name the reader that fails today.

| id | Case | Expect | Red before because |
|---|---|---|---|
| B1 | unrelated `run_attempt` row: run 1 attempt 3 (id 10, failure) beside run 2 attempt 1 (id 20, success) | pick id 20, green | module absent; a global attempt comparator (R14's rule applied across runs) picks attempt 3; R16 passes |
| B2 | cross-run attempt counters: run 1 attempt 2 re-run (id 30, failure) vs run 2 attempt 1 (id 20, success) | pick id 30, red | module absent; any `run_attempt` / `run_id` precedence picks the wrong one |
| B3 | partial attempt metadata: one row with id only, one with `startedAt` only, conclusions differ | `indeterminate`, state `pending` | R1 falls to completion time / position and returns a definite state |
| B4a | merge-gate failure + test success, required `[test, merge-gate]` | `holdRed={merge-gate}`, `gateOnlyRed`, not `allRequiredGreen` | module absent; #6042 S2 dropped the merge-gate red |
| B4b | merge-gate failure older (id 1) + merge-gate success newer (id 2) | merge-gate green | ordering, not class, decides |
| B4c | a `merge-gate` job from workflow `CI` (not `Merge gate`) red | class `ci`, `multiSource` when both exist | name alone grants hold class today |
| B5 | `CodeQL` failure only | `scanRed={CodeQL}`, `gateOnlyRed=false` | #6042 folded CodeQL into gate-only |
| B6 | review-gate failure latest | `holds=[{name:'review-gate',state:'red'}]` | no reader exposes a hold list |
| B7 | older-run re-run created after a newer run's success, rollup shape (job ids only in `detailsUrl`, no `id`): the newer run is long (started 10:00, completed 10:40, success); the re-run is created later (higher job id, started 10:05, completed 10:20, failure) | re-run wins, red | the fixture deliberately inverts completion order against creation order; R1 ranks rollup rows by `completedAt` and picks the 10:40 success |
| B8 | `test` (id 1, success) and `TEST` (id 2, failure), plus `test` with a zero-width space | three identities; required `[test]` green | #6042 `checkEvidence` lower-cases at `we:scripts/conveyor/ci-heal-verdict-recheck.mjs:96` |
| B9a | in-progress re-run (id 2, no completedAt) vs older completion (id 1, failure) | id 2, `pending` | #6042 R16 when the re-run's `startedAt` is before the older `completedAt` |
| B9b | same, rollup shape without ids, re-run queued with zero-date `startedAt` | re-run, `pending` | regression guard: R1 and R16 both pass today |
| B10 | live #6042 `review-gate` rows in their real rollup order (FAILURE…, CANCELLED…, SUCCESS…) | max job id row | regression guard on real data: R1's `completedAt` pick agrees here only because no re-run overlaps |
| B11a | CheckRun and StatusContext with the same name | CheckRun wins | regression guard for I2 |
| B11b | `mergeRequiredCheckRuns` output: REST check-runs (lower-case, `conclusion: null` in flight) beside a kept StatusContext of the same name | newest REST check-run, `pending` | regression guard for the REST path + case-insensitive state |
| B11c | two StatusContext rows, `createdAt` only, success then failure | the later `createdAt` | O2 must accept `createdAt`, or legacy statuses stall |
| B12a | nameless rows | passed through 1:1 | regression guard |
| B12b | `name: ''` with `context: 'ci/x'` | identity `ci/x` | `??` (R6) would key it `''` |
| B13 | row with another `head_sha` | in `wrongHead`, not picked | R1 has no head check (only R6 does) |
| B14 | tie on `startedAt`, no ids, success vs failure | failure | R1 keeps the later position |
| B15a | cancelled latest | state `cancelled`; not green, not red | R1 says failed, R16 says pending: two answers |
| B15b | completed, conclusion missing / unknown string | state `unknown`, never green | R16 says red, R1 says neither: two answers |
| B16 | Actions `detailsUrl` `/actions/runs/900/job/5` vs another row's REST `id: 7` | job id 5 vs 7 compared, run id 900 never used | a `/runs/(\d+)` parse would read 900 |

Every row also runs through `latestCheckNamed` / `collapseRollupToLatestPerName` (A2). The B10 fixture is captured from the real `gh pr view 6042 --json statusCheckRollup` output (trimmed to the review-gate rows) under `we:scripts/lib/__tests__/fixtures/`.

## Proof plan

1. **Red first:** run the new suite on main before the build (import fails), and the A2 loop against main's R1 (expect B3, B7, B13, B14 red). Paste both outputs in `## Progress`.
2. **Live replay, before/after:** a one-off scratch script (not committed) reads `gh pr view <n> --json statusCheckRollup,headRefOid` for every open PR in web-everything and plateau-app plus the last 50 merged, and prints, per (PR, check name), main's `latestCheckNamed` pick vs the contract's pick. Report the count of differences, and separately the count of O3 `legacy` picks, `indeterminate` names and O6 ties, and justify each difference by a BREAKS row. Expect zero differences on the required `test` check; any difference there, and any O3 id-less group on `test` whose rows disagree on state (`indeterminate`), is a stop-and-report.
3. **#6042 on the contract:** run the same replay on #6042's own rollup — the contract's summary must show `review-gate` latest red as a hold and no CI red, which is the shape the drain and ci-heal disagreed on.

## Follow-ups

- F1 — **#6042 rebuilt on the contract**: `we:scripts/conveyor/ci-heal-verdict-recheck.mjs` and `we:scripts/conveyor/ci-heal-escalation-mark.mjs` call `summarizeChecks`; `we:scripts/lib/check-state-predicate.mjs` shrinks to re-exports (or is deleted); the S2 tests run `BREAKS` against the ci-heal entry points.
- F2 — reader conformance loop: run `BREAKS` through R6 `reviewCiGate`, R8 `reduceCheckState`, R3 `failedCodeQLCheck` and R4's pick, moving R6's `statusAsCheckRow` into the contract.
- F3 — R14 `we:scripts/lib/red-main-quarantine-io.mjs`: express its within-run job rule as the contract's O4 helper.
- F4 — R15 `we:scripts/operations/coroner-rounds.mjs`: replace `createdAt`+`runAttempt` sort and the case-insensitive `review.?gate` regex with contract identity and class.
- F5 — CLI review-hold annotation in `we:scripts/operations/pr-status.mjs` and `we:scripts/fetch-parked.mjs` from `summary.holds`.
- F6 — a standards guard that refuses a new per-name "latest attempt" ordering outside the contract.
- F7 — R18 `we:scripts/conveyor/main-red-recovery.mjs` collapse and R20's `filter=latest` read in `we:scripts/conveyor/reconcile-pass.mjs` move onto the contract (R18 ranks by `updatedAt`, which is O5's completion-time trap).

## Progress

- 2026-10-30 (ET): filed and prepared under R222 so the operator can decide #6042 (rebuild on this contract vs park). Reader inventory taken on main f16501bd72 and #6042 head e3fffe14. Not queued (`--queue=false`): build waits for the operator's #6042 ruling and the R216 departure in *Preparation note*.
