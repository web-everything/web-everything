---
bornAs: xo83x9i
kind: epic
parent: "3383"
status: active
dateOpened: "2026-09-01"
dateStarted: "2026-09-03"
tags: []
scope:
  - we:scripts/conveyor/
  - we:scripts/operations/
  - we:scripts/operator/
  - we:scripts/readiness/
  - we:scripts/lib/
  - we:scripts/guard-bash.mjs
  - we:scripts/lane-pool.mjs
  - we:scripts/verify-lane.mjs
  - we:scripts/__tests__/
  - we:skills-src/conveyor/
  - we:backlog/
---

# Graduate origin/lane/mechanical-dispatcher to main in small, independently reviewable pieces

origin/lane/mechanical-dispatcher (38 ahead of main, drifts session to session) has accumulated the conveyor runner/dispatch-loop infrastructure via direct pushes, not reviewed PRs -- every #3383 session update has flagged eventual graduation but never started it. Tracks that ongoing graduation: land stable, inert pieces first (e.g. the we:scripts/conveyor/review-round-tag.mjs / we:scripts/conveyor/review-status-tag.mjs informative PR labels, standalone with no we:skills-src/conveyor/runner.mjs wiring); hold back the reconcile-pass runner wiring (the continuous review-dispatch loop, commit 186801a0) until #3437's fix lands on main. Covers the whole ongoing effort, not one PR.

## Done when

1. **Executable** — `git rev-list --left-right --count origin/main...origin/lane/mechanical-dispatcher` reports `0` on the right (lane-branch-ahead) side: every commit unique to `origin/lane/mechanical-dispatcher` has landed on `main` through its own small reviewed PR, or this item is resolved with an explicit note naming which remaining commits were deliberately dropped/superseded and why.
2. The reconcile-pass runner wiring that dispatches `review`/`fix` continuously on a tick loop (`origin/lane/mechanical-dispatcher`'s `186801a0` and anything layered on it) is not cherry-picked to `main` until `git log main -- we:scripts/conveyor/reconcile-core.mjs` shows the `#3437` name-based-bind fix (or `backlog/3437-*.md` is `status: resolved`) — landing the continuous loop before that fix would reproduce `#3437`'s live double-dispatch bug on `main`'s own runner.
3. Each landed increment is its own small PR through the normal lane → `we:scripts/verify-lane.mjs` → `we:scripts/operations/run.mjs open-pr --mode=land` pipeline — never a bulk merge of the branch, and never a direct push to `main`.

## Slice procedure

How each slice (a child of this item) graduates, per the statute
`we:docs/agent/platform-decisions.md#poc-branch-mechanical-sync` point 4 (#3804 Fork 4, built in #3836):

1. **Any time, whatever the sync state.** Graduation slices may land on `main` whether or not the branch is
   current with `main`. They are exempt from the `branch-drift-blocked` hold: the dispatch plan
   (`we:scripts/readiness/dispatch-plan.mjs`) treats a card whose `parent` is this item (the branch's
   registered `graduationItem` in `we:scripts/lib/poc-branches.json`) as a graduation slice.
2. **Order follows this item's dependencies.** Land slices in their `blockedBy` order (see the slice list under
   Progress); a slice waits for the slices it depends on.
3. **Freshness rule: graduation slices never copy a file `main` has moved.** For each file a slice ports, check whether `main` has
   a commit to it since the merge base (`git log $(git merge-base origin/main origin/lane/mechanical-dispatcher)..origin/main -- <file>`).
   If it has, apply the branch's change onto `main`'s current file as a diff; never copy the branch's version
   over it. A ported file that is in the open conflict set takes the staging ref's resolution
   (`lane/mechanical-dispatcher-catchup`) when one exists; otherwise the port's version is recorded as the
   resolution the reconcile agent must adopt.
4. **Full gate on `main`'s tree.** Each slice is its own small PR (Done-when 3) and runs `check:standards`,
   `test` and `smoke` on `main`'s tree. This replaces rule 1 of #3383's Priority order for graduation slices.

## Progress

- 2026-09-03: Landed `computeFreeSlots` dirty-lane exclusion (`origin/lane/mechanical-dispatcher`'s `c7316eb40`,
  hand-reapplied onto `main`'s current `we:scripts/readiness/conveyor-state.mjs` — the branch commit didn't
  cherry-pick clean, main had independently diverged elsewhere in the same file). Confirmed already-landed via
  separate PR (content-identical, different commit shape): `26b6bbe4b`/`e603e919f`/`5c75464c1`
  (review-round-tag/review-status-tag) and `7d7e398b6`/`4d5d98365`/`d4fa4667f` (dispatch-lane fix/ci-heal
  widening, landed under #3332 instead). Still ahead on `origin/main...origin/lane/mechanical-dispatcher`:
  ~26 commits, most entangled with the held-back reconcile-pass tick-loop wiring (`186801a04`+) or with
  `we:skills-src/conveyor/supervisor.mjs` (doesn't exist on `main` yet — a bigger follow-on piece, not this PR's
  target). Next standalone candidates identified for a future increment: `we:scripts/verify-lane.mjs` request/check mode +
  `we:scripts/conveyor/verify-dispatch.mjs` (`3faf739c5` — bigger, multi-concern), `34302e2c3` (lane-pool retry
  fetch), `d37731fd7` (lane-pool flag validation).

- **2026-09-04 (recon/planning session, no build).** The branch was reconciled with `main` earlier tonight
  (a prior session took it from 97-behind/42-ahead to 0-behind, pushed as `3e4383f1c`) — this rewrote every
  commit SHA on the branch, so **every specific hash named in the 2026-09-03 entry above is now stale**; treat
  it as historical narrative only, not a lookup key. Fresh ground truth, taken right now:
  `git rev-list --left-right --count origin/main...origin/lane/mechanical-dispatcher` → `0` behind, **30**
  ahead (not the "~26" estimated pre-reconciliation) — 46 files, +4645/-194.

  **`#3437` is confirmed `status: resolved`, and its name-based-bind fix
  (`bind review-dispatch sessions by session name, not just cwd/HEAD-oid`) is confirmed present on `main` in
  `we:scripts/conveyor/reconcile-core.mjs` today** — this item's own Done-when #2 gate is satisfied, so the
  reconcile-pass runner wiring is no longer held back; it is simply not yet sliced/landed.

  Of the 30 commits: one (`aa8c8823d`, review-round-tag/review-status-tag labels) is confirmed superseded —
  identical content already landed on `main` under a different SHA, nothing to do. One (`c30fe565b`,
  dispatch-lane fix/ci-heal widening) turns out to touch only a test file on the branch — the widening itself
  is already on `main` (landed under #3332 per the entry above); only its residual test coverage is still
  missing, folded into the dispatch-lane-hardening slice below. One (`d23678688`) is a pure merge commit
  (`we:package-lock.json` only), and one revert pair (`d281428c2`/`c24db21dd`, a live-fire test of #3412) nets
  to zero — both ignorable. Eight commits (`3003410fd`, `a2e528c14`, `4f1b19e0b`, `a178cffd0`, `2242b54b0`,
  `7793ce938`, `bbe23dcd3`, `fa3315eae`) are session-log edits to `we:backlog/3383-*.md` and
  `we:backlog/3105-*.md` — branch-local narrative that doesn't cherry-pick cleanly onto `main`'s
  independently-evolved #3383 card; not proposed as a graduation slice, any still-relevant findings should be
  folded into `main`'s #3383 card by hand as normal session-update hygiene. Two (`ef1120a32`, `011a9b912`,
  "session-reaper: ...") touch only a test file with no matching implementation change in this range —
  low-value, not sliced separately.

  **The remaining ~18 commits group into 7 slices, filed as real child stories under this item** (JIT-numbered
  hashes below; the drain assigns their `#NNN` at land):

  1. `we:scripts/lane-pool.mjs` hardening (fetch-race retry, flag validation) + `we:scripts/lib/lane-lease.mjs`
     — **we:backlog/3481-*** — standalone, unblocked, ready to build now.
  2. `we:scripts/verify-lane.mjs` request/check gate mode + `we:scripts/conveyor/verify-dispatch.mjs` (the
     "wait primitive" fork of #3105's still-open footgun decision) — **we:backlog/3484-*** — standalone,
     unblocked, ready to build now.
  3. `we:scripts/operations/dispatch-lane.mjs` and `we:scripts/operations/dispatch-lane-io.mjs` hardening
     (attempt-tagging retries #3110, residual fix/ci-heal test coverage, `WE_DISPATCH_KIND` wiring) —
     **we:backlog/3488-*** — `blockedBy: 3484` (slice 2 above; it stamps the env var slice 3 reads).
  4. Core reconcile-pass payload, split into 3 landing-ordered parts since it's the epic's largest, most
     entangled body of work: (a) `we:scripts/operations/route-pr-outcome.mjs` and
     `we:scripts/operations/route-pr-outcome-io.mjs` (new) — **we:backlog/3482-***, unblocked; (b)
     `we:skills-src/conveyor/supervisor.mjs` (new standalone daemon) — **we:backlog/3483-***,
     `blockedBy: 3482`; (c) the `we:skills-src/conveyor/runner.mjs` wiring that actually activates the
     continuous reconcile-pass tick loop — **we:backlog/3486-***, `blockedBy: 3482, 3483` — this is
     the piece Done-when #2 was gating, now unblocked by #3437, but it should still get the most scrutiny of
     any slice here and land last, validated with a single manual tick before any continuous loop runs against
     it (mirroring #3437's own Done-when #4 caution).
  5. `we:scripts/conveyor/tick-core.mjs` durable build-guard-floor fix + supervisor/runner crash-loop and
     idle-with-queue alerting hardening (#3398/#3403/#3404/#3406/#3416) — **we:backlog/3487-***,
     `blockedBy: 3483, 3486` (these are fixes layered on top of the new supervisor/runner machinery, not
     separable from it in the branch's own commit history).
  6. Follow-up (not a graduation slice, a fresh child of slice 2): fold the gate's request/check modes into the
     declared `we:scripts/operations/verify.mjs` operation, per #3224 — already fully drafted, unlanded, on the
     branch as `we:backlog/xab3jh7-*`; re-filed here as a real numbered child rather than cherry-picked
     verbatim — **we:backlog/3485-***, `blockedBy: 3484`.

  Slices 1 and 2 above are queued into the live conveyor tonight (2026-09-04) — see their own cards. Slice 3
  and the three parts of slice 4/5 are filed but intentionally NOT queued yet: their `blockedBy` edges mean
  the conveyor can't dispatch them until their prerequisite lands, and slice 4(c) in particular needs a human
  or a very deliberate agent turn at land time, not blind automated dispatch.

- **2026-09-06/07 (standing-agent iteration, heavy concurrent-activity night).** Re-measured fresh:
  `origin/main...origin/lane/mechanical-dispatcher` was `126`/`33` at the start of this pass (main had moved
  ~120 commits from unrelated concurrent work since the last measurement; the branch itself also grew by a
  few commits, mostly session-log noise plus one new `file-item` prototype unrelated to this item's scope).
  Landed this pass:

  - **#3481** (`we:scripts/lane-pool.mjs` hardening) — found ALREADY BUILT with an open-but-stuck PR (#1930,
    `CONFLICTING`/stale, opened 2026-09-05 by an earlier session and never finished). Used the finish skill:
    cloned the existing `lane/3481b-graduate-lane-pool-hardening` ref, merged `origin/main`, resolved one real
    conflict in `we:scripts/lib/__tests__/lane-lease.test.mjs` (both sides had independently added a new,
    non-overlapping `describe` block at the same insertion point — kept both), reran the full gate green,
    pushed, and landed via `we:scripts/lane-resume.mjs land`. Merged as `a57be8a09`.
  - **#3484** (`we:scripts/verify-lane.mjs` request/check mode) — same situation: open-but-stuck PR #1926
    (`CONFLICTING`, failing `review-gate` checks). Same finish-style repair: merged `origin/main`, resolved a
    real conflict in `we:scripts/guard-bash.mjs` + its test — `main` had independently landed a DIFFERENT new
    guard (`truncatedOperationJsonReason`, the `--json`-into-`head`/`tail` corruption guard, 2026-09-06) at the
    exact same insertion point as this lane's `dispatchedAgentVerificationReason` (#3105). Both are genuine,
    non-overlapping additions — kept both, in sequence, and merged their import lists. Full gate green, pushed,
    independent review dispatched via `we:scripts/operations/review-dispatch.mjs` (verdict: accept, converged
    round 1; one non-blocking test-coverage-gap finding on `fetchOriginPruneWithRetry`, filed as prose in the
    review, not a new backlog item). PR still open pending drain at the time of this note.
  - **#3483** (`we:skills-src/conveyor/supervisor.mjs`) — built fresh (not previously attempted): confirmed by
    reading the actual code, not the card's inferred grouping, that `we:skills-src/conveyor/supervisor.mjs`
    depends on nothing from the sibling `route-pr-outcome` slice — only `RUNNER_LOCK_ROOT` from
    `we:skills-src/conveyor/runner-lock.mjs` (already on `main`) and node builtins. Ported byte-identical + its
    64-test suite + the launchd example, resolved #3483, and in the same lane fixed **#3482**'s stale
    bookkeeping (`status: active` left over from an earlier session that had actually already landed its
    content under `9ff2f774c` but never flipped the card to `resolved`). Landed as PR #1978 → merged
    `1d66d33a9`.

  **Operational friction hit this pass, worth naming for the next session:** the shared lane pool was fully
  saturated (44/44 held-or-dirty) for most of this pass — both this session's own new-slice work and BOTH
  independent review dispatches (#1930, #1926) initially failed with `blocked-on-infra` before any of them got
  a lane. Recovered by `we:scripts/lane-pool.mjs provision --count=N --acquirable` (needs a large `--count` to
  push the cap past the existing pool size — `count=1` only re-checks lane-1, it does not grow the pool). Also
  hit: (a) `we:scripts/operations/run.mjs open-pr --mode=land` reads "the HEAD being landed" from the CALLING
  checkout's own `HEAD`, not from the pushed `--ref` — it must be run from inside the lane clone whose tip was
  verified, not from the primary checkout, or it spuriously reports the verification as stale; (b) a foreground
  `open-pr`/`review-pr` call that legitimately takes long (waiting on CI, or on a lane) can get killed by an
  external tool timeout mid-effect, leaving the run record's effect at `pending`/`unknown` even though the
  underlying `gh` side effect (PR opened, label swapped) already fired — recovered each time by checking the
  ACTUAL GitHub state by hand, then hand-patching that one effect's `status` field in the run record to
  `applied` or `failed` (matching reality) before `--resume`; (c) GitHub's own API rate limit was hit mid-session
  from the sheer concurrent `gh` call volume across every agent active tonight. None of this is unique to this
  item — see the freshly-filed #3553/#3554 (skill-coverage gaps for `we:scripts/conveyor/branch-sync.mjs` /
  `we:scripts/conveyor/reconcile-finding.mjs`) for related tooling gaps; a fresh item for "resume vs re-verify"
  ergonomics on `open-pr`/`review-pr` would be worth filing if this recurs.

  **Still ahead after this pass:** `origin/main...origin/lane/mechanical-dispatcher` should drop by the 3
  slices above once #3484's PR clears the drain, but the ahead-COUNT itself won't hit 0 from content landing
  alone (these land as fresh commits on `main`, not cherry-picks — this item's Done-when #1 is tracked by
  slice completion, not by the raw `git rev-list` count reaching 0 organically). Remaining unblocked/next:
  **#3488** (`we:scripts/operations/dispatch-lane.mjs`/`we:scripts/operations/dispatch-lane-io.mjs` hardening,
  `blockedBy: 3484` — now unblockable once #3484 lands) and **#3485** (fold request/check into
  `we:scripts/operations/verify.mjs`, same `blockedBy`). **#3486** (the `we:skills-src/conveyor/runner.mjs`
  reconcile-pass wiring, ~430 lines of diff remaining, a named-busy hot file tonight per this session's own
  dispatch instructions) was deliberately NOT attempted this pass — it needs the dedicated, low-contention,
  most-scrutiny turn its own card calls for, not a slot in a night this saturated. **#3487** stays
  `blockedBy: 3483, 3486` as before, now half-unblocked (3483 landed).

- **2026-09-21 (operator priority: graduation; land-advance slices filed).** The `land-advance` operation and
  everything it imports exists only on the prototype branch. Filed as six children, hash ids (the drain numbers
  them at land), each ported as a diff under the #3804 statute, none built yet:
  1. `3853`: `we:scripts/operations/land-advance-tools.mjs` (26 lines, no imports). No blockers.
  2. `3854`: the land-advance core, `we:scripts/operations/land-advance.mjs` plus its repair and escalations
     modules, the pure tests and the fixture. `blockedBy: 3853`.
  3. `3855`: `we:scripts/conveyor/session-verdicts.mjs` and `we:scripts/conveyor/session-verdicts-io.mjs` + tests
     (minus the reaper-plan test block, which needs the reaper slice). `blockedBy: 3853, 3854`.
  4. `3851`: `we:scripts/conveyor/driver-watchdog.mjs` and `we:scripts/conveyor/driver-mode.mjs` + the watchdog test. No blockers.
  5. `3852`: `we:scripts/operations/ci-heal-pr-dispatch.mjs`. No blockers.
  6. `3856`: `we:scripts/operations/land-advance-io.mjs` and `we:scripts/operations/land-advance-cli.mjs`, the
     `we:scripts/operations/run.mjs` registration, the http-adapter pin and the io, cli, real and repair-io tests.
     `blockedBy` all five above. This also unblocks the reaper slice above (it imports `readFollowUps` from the io module).

  Checked against the earlier inventory and corrected: (a) the core does NOT depend on the watchdog, verdicts or
  ci-heal slices, only on the tools slice; (b) the verdicts slice DOES depend on the core, because its test imports
  the core and its escalations module; (c) that same test imports `classifySessionReapWithVerdict`, which `main`'s
  reaper does not export, so its last describe block waits for the reaper slice; (d) the repair-io test belongs to
  slice 6, not the pure core. Order: tools → core → verdicts, with the watchdog and ci-heal slices anywhere, IO last.

- **2026-09-22 (Step 0 re-plan: whole remaining delta sliced; build ON HOLD).** Measured against branch tip
  `ff1618065` (the **snapshot** every slice ports from): 287 ahead / 721 behind, merge base `ca7e68b71`
  (2026-09-14 — the branch has not synced with main since, despite `autoSync`). Comparing each file tip-to-tip,
  so already-landed work is excluded: **212 implementation files (~42k lines) + ~48k test lines still differ**;
  58 of those files main also changed (diff-merge under Slice procedure rule 3). The earlier cards covered ~22
  files, so every other file now has a card. Slices follow the branch's import graph, so each one passes the
  gate on main's tree once its blockers have landed.

  **Operator rules (2026-09-22):** faithful port, no behaviour change while porting; nothing is dropped, and
  the end goal is still the whole branch; **no slice is dispatched until the operator confirms agent routing
  works** — every new card was filed with `--queue=false`.

  Waves (blockers in each card's `blockedBy`):
  - **A (leaves):** 3901 coordination+action · 3895 telemetry · 3897 dispatch contracts ·
    3891 priority/tracker libs · 3893 run-quality · 3911 conveyor watches · 3894 gemini-direct-task ·
    3890 guard-bash · 3854 land-advance core.
  - **B:** 3855 · 3863 · 3902 delivery foundation · 3907 judges/review-pr · 3865 · 3892 restart-runner+priority-sync.
  - **C:** 3903 deliver-item → 3904 fix/ci-heal wrappers, 3905 prepare wrappers · 3856.
  - **D:** 3906 dispatch path → 3908 review loop · 3862 · 3898 wip-agents/report.
  - **E:** 3487 (**re-scoped to the runtime core, size 8**, one manual tick before any loop) · 3909 tracker/turn-digest ·
    3899 host sampler (after 3487, still changing on 09-21) · 3896 usage-report · 3900 validate-and-promote.
  - **Tail:** 3910 re-diffs against the moved tip, ports the docs, and closes this epic.

  Critical path: 3897 → 3902 → 3903 → 3906 → 3908 → 3487. Ordering bugs fixed on the existing
  cards: `we:scripts/operations/land-advance-items.mjs` moved from 3865 into 3854; 3856 now also waits on 3865 and 3891;
  3863 waits on 3901; 3865 no longer waits on decision 3864 (ratified; it resolves when 3865+3856 land);
  3862 waits on 3906 and 3907. `we:scripts/operations/run.mjs` and the http-adapter pin are shared: each slice appends only
  its own lines.

- **2026-09-22 (merge notes + #3487 split; build still ON HOLD).** Read-only trial merges were run for every file that both main and the branch changed. Their results are now on the cards as merge notes: #3890, #3894, #3897, #3903, #3906, #3907, #3908 and #3487.
  - **#3487 split.** It now keeps only the runner core, as the last slice. Three new slices land before it: 3916 (test setup and heavy-command admission), 3917 (dispatch gate and tick-core) and 3915 (land path, gh-throttle and lease-reaper).
  - **Order fix.** #3906 now lands before #3903. The wrapper needs a function from dispatch-lane-io, so the marker module moved into #3906 to break the cycle.
  - **#3894 resolved with no code change.** Main already has everything the branch has there.
  - **New critical path:** #3897 → #3902 → #3906 → #3903 → #3904 → #3908 → #3487.
  - **Landing rule.** Between #3908 and #3487, the conveyor runner must not run continuously on main.
  - **Behaviour change to expect.** #3907 turns the advisory Codex and Antigravity judge seats on by default for main reviews, whenever the model-probation registry marks them as probation or trusted.

- **2026-09-23 (snapshot moved to `600acc14f`; #3857 probed live; wave A ready).**
  - **Snapshot move.** The graduation snapshot moves from `ff1618065` to the prototype tip `600acc14f`, 14 commits
    later. Those commits are #3857's model-tier table, #3783's concurrent-baseline harness, and rules 4, 5 and 7
    of #3690. Merge-note addenda were re-run at the new snapshot on #3897, #3906, #3907 and #3908.
    - `we:scripts/operations/dispatch-lane-io.mjs` rose from 7 to 10 conflicts, and
      `we:scripts/operations/dispatch-lane.mjs` from 5 to 6.
    - `we:scripts/conveyor/concurrent-baseline-comparison.mjs` and `we:scripts/conveyor/log-delegation-trial.mjs`
      join #3897.
  - **#3857 probed live, from a throwaway clone of `600acc14f`.** Done-when 5:
    - A real `we:scripts/operations/run.mjs dispatch-task` with no env model recorded
      `workerModel: { source: 'table', tier: 'sonnet', name: 'claude-sonnet-5' }`, and the started session's
      transcript shows `claude-sonnet-5`.
    - A second call with `WE_DISPATCH_AGENT_ARGS='["--model","opus"]'` and no reason was refused ("a hand-set
      --model … with no --modelReason is refused") and started no session.
    - First attempt: an untrusted clone folder made `claude --bg` fail ("Workspace not trusted"). That is the
      #3748 class, not a #3857 defect, and it left one stale in-flight run record, `probe-3857-sonnet`.
    - #3857's own card is claimed by another session, so its status flip is left to that session.

- **2026-09-24 (#3917 built: dispatch gate + tick-core pure core, S2).** Ported
  `we:scripts/readiness/dispatch-pause.mjs` (+test), `we:scripts/readiness/dispatch-plan.mjs` (+test),
  `we:scripts/readiness/queue-report.mjs`, `we:scripts/conveyor/tick-core.mjs` (+2 tests) and
  `we:scripts/check-standards-rules.mjs` (+test) from snapshot `600acc14f`, diff-merged per rule 3. Main had
  moved further on `we:scripts/readiness/dispatch-plan.mjs`, `we:scripts/readiness/queue-report.mjs` and
  `we:scripts/conveyor/tick-core.mjs`/its test since #3917's own merge notes were written (2026-09-22) — the
  card's precomputed catchup-ref resolutions were reused as the BRANCH-side input, then a fresh diff-apply
  carried each onto main's CURRENT tip:
  - `we:scripts/readiness/dispatch-plan.mjs` (+test): preserved main's own `driftGraduationItem` (#3836),
    `findPocBranch`/`readRegistry` imports, and its `runJson` → `await runJson` async change, alongside the
    branch's `--queue-file` item-pull (#3720), `dispatchPausedKinds` and `sizePolicy`.
  - `we:scripts/readiness/queue-report.mjs`: unioned main's own `needs-investigation` addition with the
    branch's `no-size` (#3849) addition to `NOT_READY_REASONS` — same array, non-overlapping additions.
  - `we:scripts/conveyor/tick-core.mjs` (+test): preserved main's own `resolveChildTimeoutMs` import (#3989
    bounded-child rollout) and the multi-repo `lanePoolListArgsForRepo` free-lane read (#3960/#3962),
    alongside the branch's kind-scoped dispatch-pause wiring; the test file unions main's new
    `lanePoolListArgsForRepo` describe block with the branch's kind-scoped-pause describe block.
  - `we:scripts/check-standards-rules.mjs` (+test): clean 3-way, 0 conflicts, despite 2 more main commits
    landing on it since the card's notes.
  - **Own bug found and fixed** (caught by this slice's own test suite, not by inspection): the
    `--queue-file` restructuring scoped `selection`/`observeSelection` inside the non-queue-file branch only,
    but `plan.selection = [...selection.values()]` is read later in `main()` unconditionally — a live
    `ReferenceError`. Fixed by hoisting `selection` to the outer scope.
  - Full gate: `npm run test:unit` (574/574 files, 16455 tests, 0 failures), `npm run check:standards
    --scope=3917-...` (0 errors). Landed as PR #2597, verified green at `e98dda4b6`, labelled
    `review:pending` for the drain.
  - **Not yet landed.** PR #2597 sits behind a REPO-WIDE review-dispatch stall — `review-status:review-stalled`
    on 5+ other open PRs (#2596, #2591, #2590, #2584, plus #2597) at the same time, unrelated to this slice's
    own diff. Several concurrent sessions already hold leases on exactly this class of fix
    (`fix-2549`/`fix-2578`/`fix-2580`/`fix-review-labels-3383-daemon` in the lane pool at the time of this
    note) — per this repo's own doctrine (fix the daemon, never the instance by hand), this session did not
    hand-dispatch a review to force it through. #3917 stays unresolved until the PR actually merges; the next
    session/daemon pass should resolve it once `gh pr view 2597 --json mergedAt` is non-null.

- **2026-09-24 (#3895 telemetry core, first wave-A build): PR #2595 open, pending review+drain.** Ported
  `we:scripts/operations/command-redact.mjs`, `we:scripts/operations/telemetry.mjs`,
  `we:scripts/operations/telemetry-store.mjs`, `we:scripts/operations/telemetry-cli.mjs` and
  `we:scripts/operations/__tests__/command-redact.test.mjs` from snapshot `600acc14f`. None of the 4 files
  exist on `main`, and none have been touched by `main` since the merge base `ca7e68b71` — a clean
  byte-identical port, no diff-merge needed. `we:scripts/operations/command-redact.mjs` (argv
  credential/control-char redaction before telemetry is persisted or printed) got the extra scrutiny the
  card called for as a security-relevant file: confirmed zero independent `main` commits to it, so there was
  no merge to get wrong and no risk of a redaction pattern being dropped.
  - **Scope correction found at land time.** `we:scripts/operations/__tests__/telemetry-wiring.test.mjs` and
    `we:scripts/operations/__tests__/telemetry.test.mjs` were in #3895's original scope but statically import
    modules that are true downstream leaves — `we:scripts/operations/minimal-context-provider.mjs` (#3902),
    `we:scripts/operations/host-process-sample.mjs` (#3915), `we:scripts/operations/review-dispatch-wrapper.mjs`
    and the prepare wrappers (#3908/#3905) — none of which exist yet, and all of which are themselves
    `blockedBy: 3895`. The original Done-when ("passes on main's tree") was unsatisfiable within this slice
    alone. Re-homed `we:scripts/operations/__tests__/telemetry.test.mjs` to #3915 (its one dependency is
    already that card's scope) and `we:scripts/operations/__tests__/telemetry-wiring.test.mjs` to #3908 (the
    last-landing of its three dependencies per the critical path `#3897 → #3902 → #3906 → #3903 → #3904 →
    #3908`), with dated notes on all three cards — the same "moved here" pattern #3908 already used for
    `we:scripts/operations/__tests__/action-ground-truth.test.mjs` from #3901.
  - **Full gate:** `npm run test:unit` 574/574 files, 16411 tests, 0 failures; `npm run check:standards
    --scope=3895-...` 0 errors; lane `verify` green at `914bd921e`. PR #2595's own CI `test` and `smoke`
    checks are both green (local `npm run test:smoke` fails only because it needs a FrontierUI dev server on
    `:3001` as a sibling checkout, per `we:.github/workflows/ci.yml` — unrelated to these 4 backend files;
    CI's own sibling checkout confirms the real gate is green).
  - PR #2595 is labelled `review:pending` (blast-radius/size, 2672 changed lines — mostly
    `we:scripts/operations/telemetry.mjs` and `we:scripts/operations/telemetry-store.mjs` themselves) and left
    for the drain to land, per the epic's own established pattern (see the 2026-09-06/07 entry). #3895 is not
    yet resolved — that happens once the PR actually merges.

- **2026-09-24 (#3891 landed; confirmed on `main`'s tree).** Dispatched to graduate #3891 (priority-order
  and prototype-tracker-compact libraries) per its own card and this item's slice procedure, but on arrival
  found it already resolved (`status: resolved`, `dateResolved: 2026-09-24`) — a concurrent wave-A/B session
  had landed it first, via PR #2572 (`lane/batch-2026-09-24-waveA2-3891`, batched together with #3890, #3893,
  #3906, #3911 and unrelated work), merged 2026-09-24T13:06:36Z. Verified rather than re-done: all 5 files
  (`we:scripts/lib/priority-markers.mjs`, `we:scripts/lib/priority-order.mjs`, `we:scripts/lib/tracker-page-hash.mjs`,
  `we:scripts/lib/prototype-tracker-compact.mjs`, `we:scripts/lib/prototype-tracker-render.mjs`) and their tests
  are present on `main`; `npx vitest run` on the 3 test files this card names passes — 58 tests, 50 passed,
  8 intentionally skipped (2 pending #3892's `priority-sync`, 6 pending #3909's
  `we:scripts/lib/prototype-tracker-compact-io.mjs`), matching the landed commit's own message. No further
  build needed for #3891; this entry only closes the Progress-log gap the landing PR itself didn't fill.

- **2026-09-24 (#3916 built; the first slice this card's own merge notes were stale for).** Ported #3916
  (test setup, heavy-admission and file-locks) from snapshot `600acc14f`. Confirmed live what rule 3 warns
  about: **its own 2026-09-22 merge notes had already gone stale by land time.** `main`'s `d79512e13`
  (landed 2026-09-23, one day after the notes were written) independently ported the branch's ghost-marker/
  stale-waiter fix under a different shape (`classifyWaiter`/`reapStaleWaiters`, `staleWaiting` as a count)
  and its own commit message calls the branch's `partitionWaiting`/`pruneStaleWaiting` "now-superseded" — so
  #3916 does NOT re-introduce those exports or the array-shaped `staleWaiting` the old notes called for;
  doing so would have duplicated `main`'s already-chosen design and broken its own live tests. Only the
  genuinely un-landed piece of the branch's heavy-admission/file-locks work — the #3383 slot-reentrancy-by-
  real-pid fix (`8983b136a`) — was ported, onto `main`'s current files as a diff. `we:vitest.integration.config.ts`
  and `we:.gitignore` had also each taken one more independent `main` commit since the notes were written;
  both merged clean (disjoint insertion points). `we:package-lock.json` needed no `npm install` regen — it was
  byte-identical to the merge base except the one-line license field the notes already named. Full gate:
  573 test files / 16377 tests, `check:standards` 0 errors, `verify-lane` green. Pushed
  `lane/3916-graduate-test-setup-heavy-command-admission-and-file-locks-c`, opened PR #2594 (green,
  labelled `review:pending`, `careLevel=elevated` per the shape command). Self-clearing the review was
  correctly refused (#2439: the clearing session is the PR's author) — this session cannot manufacture the
  independence a different session's `/review` pass (or the drain, once a review daemon is live for this
  repo) must supply. **#3916 is left `status: active`, NOT resolved** — landing on `main` is this item's own
  done-when, and the PR has not landed yet.

- **2026-09-24 (#3854 landed — the land-advance core).** Graduation slice 5 of 6 for the land-advance
  operation, building on #3853 (`we:scripts/operations/land-advance-tools.mjs`, already on `main`). Ported
  `we:scripts/operations/land-advance.mjs` (the declared operation, `LAND_ADVANCE_OP`/`OWED_ACTIONS`),
  `we:scripts/operations/land-advance-repair.mjs`, `we:scripts/operations/land-advance-escalations.mjs`,
  `we:scripts/operations/land-advance-items.mjs` and the fixture byte-identical from the branch tip
  (confirmed via `git diff origin/lane/mechanical-dispatcher` reporting 0 lines once staged) — none of
  these five files existed on `main`, so this was a straight new-file port, not a diff-merge. Every named
  import they take (`registry`, `step-kinds`, `constellation-repos`, `lane-concurrency`, `lane-manifest`,
  `dispatch-plan`, `hiccup-classify`, plus #3853's own `we:scripts/operations/land-advance-tools.mjs`) was
  checked name-by-name against `main`'s real exports before porting, matching this card's own claim.

  `we:scripts/operations/__tests__/land-advance.test.mjs` needed a real adaptation, not a straight copy: the
  branch's current copy has grown two test cases since this card was filed, calling `priorityQueue`/
  `reconcileHolds` from `we:scripts/operations/land-advance-items-io.mjs` — that module is #3865's scope, and
  #3865 is `blockedBy` this item, so it cannot land first. #3865's own card already flagged this forward
  dependency ("Neither #3854 nor #3856 has been re-scoped for this yet"). Deferred rather than dropped: one
  `it()` (the `priorityQueue` case) and the whole `describe('#3720 owed PR work honours reconcile-pass
  refusals')` block (its one case calls `reconcileHolds`), each replaced with a comment pointing at #3865 to
  restore when `we:scripts/operations/land-advance-items-io.mjs` lands. Everything else in the file,
  including the `dispatchPlan`-based item-pull/budget/mode cases (`dispatchPlan` is already on `main`), is
  untouched.

  Verification: 51/51 on the two pure test files, 34/34 on `we:scripts/operations/__tests__/http-adapter.test.mjs`
  (confirming no registration pin is needed yet — the module isn't wired into `we:scripts/operations/run.mjs`,
  that's slice 6/#3856), full suite 575 files / 16407 tests / 0 failed, `check:standards` 0 errors,
  `verify-lane` green. Pushed `lane/3854-graduate-land-advance-core`, opened PR #2593 (639 changed lines,
  green, labelled `review:pending` on the size/blast-radius heuristic as expected). The independent review
  this session dispatched (`we:scripts/operations/review-dispatch.mjs`) stalled repeatedly with
  `outcome: blocked-on-infra` over roughly 100 minutes — at the time, EVERY open PR in the repo was stuck in
  the identical `review-status:reviewing`/`review-stalled` oscillation (confirmed via `gh pr list`), and the
  machine was running 62 concurrent `claude` processes at load average 13–18. Not a defect in the port; no
  daemon code was touched — the resident review daemon's own outer retry loop is what eventually cleared it
  once load eased (down to ~8 by the time it converged). Verdict landed `review:accepted` → `ready-to-merge`
  → merged `33fdc6cdb` at 2026-09-24T19:55:31Z. Resolved via the drain's own auto-resolve-on-land plus this
  session's own `we:scripts/operations/run.mjs resolve --ref=3854 --graduatedTo=none` call (idempotent with
  it): `status: resolved`, `dateResolved: 2026-09-24`.
