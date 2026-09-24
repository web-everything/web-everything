---
bornAs: xvknnyb
kind: story
size: 5
parent: "3443"
status: open
blockedBy: ["3906", "3904", "3907", "3905"]
scope: ["we:scripts/conveyor/__tests__/advisory-round-count.test.mjs", "we:scripts/conveyor/__tests__/autofix-review-findings.test.mjs", "we:scripts/conveyor/__tests__/fix-autofix-gate.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/conveyor/advisory-round-count.mjs", "we:scripts/conveyor/autofix-review-findings.mjs", "we:scripts/conveyor/fix-autofix-gate.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/operations/__tests__/review-dispatch-wrapper.test.mjs", "we:scripts/operations/__tests__/review-dispatch.test.mjs", "we:scripts/operations/review-dispatch-wrapper.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-routing.test.mjs", "we:scripts/conveyor/__tests__/parked-pr-conflict-dispatch-integration.test.mjs", "we:scripts/operations/__tests__/action-ground-truth.test.mjs", "we:scripts/operations/__tests__/telemetry-wiring.test.mjs"]
dateOpened: "2026-09-22"
tags: []
---

# Graduate review loop: review-dispatch changes, wrapper, autofix and reconcile-fix-dispatch from lane/mechanical-dispatcher to main

Ports 8 files (we:scripts/operations/review-dispatch.mjs, we:scripts/operations/review-dispatch-wrapper.mjs, we:scripts/conveyor/autofix-review-findings.mjs, we:scripts/conveyor/fix-autofix-gate.mjs, we:scripts/conveyor/reconcile-fix-dispatch.mjs, we:scripts/conveyor/reconcile-core.mjs, we:scripts/conveyor/reconcile-pass.mjs, we:scripts/conveyor/advisory-round-count.mjs) plus their tests. On the critical path. Main also changed these files, so each gets a diff-merge: we:scripts/operations/review-dispatch.mjs, we:scripts/conveyor/reconcile-fix-dispatch.mjs. Graduation slice of epic #3443 (see its Slice procedure). FAITHFUL PORT: no behaviour change while porting; the branch code lands as-is (operator, 2026-09-22). Port from snapshot 600acc14f of origin/lane/mechanical-dispatcher. For every file main has changed since the merge base ca7e68b71 (check with git log ca7e68b71..origin/main -- <file>), apply the branch diff onto main's current file; never copy the branch file over it. Add only this slice's own lines to we:scripts/operations/run.mjs and the we:scripts/operations/__tests__/http-adapter.test.mjs pin (append-only, so parallel slices merge cleanly). Full gate on main's tree: check:standards, test, smoke. Hold lifted 2026-09-24: the #3857 model-tier table passed a live probe and the operator started wave A.

## Done when

1. **Executable** — `npx vitest run we:scripts/conveyor/__tests__/advisory-round-count.test.mjs we:scripts/conveyor/__tests__/autofix-review-findings.test.mjs we:scripts/conveyor/__tests__/fix-autofix-gate.test.mjs we:scripts/conveyor/__tests__/reconcile-core.test.mjs we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs we:scripts/operations/__tests__/review-dispatch-wrapper.test.mjs we:scripts/operations/__tests__/review-dispatch.test.mjs we:scripts/conveyor/__tests__/reconcile-fix-routing.test.mjs we:scripts/conveyor/__tests__/parked-pr-conflict-dispatch-integration.test.mjs we:scripts/operations/__tests__/action-ground-truth.test.mjs we:scripts/operations/__tests__/telemetry-wiring.test.mjs` passes on main's tree (all of this slice's tests; each fails before the port because its module is missing or differs).
2. **Executable** — `npm run check:standards` reports 0 errors, and the PR's required `test` and `smoke` checks are green.
3. **Faithful port** — for each ported file, `git diff 600acc14f -- <file>` (prototype snapshot vs main after the port) shows only main's own later changes kept by the merge notes, never a behaviour change of the branch code; runtime data files (e.g. `we:scripts/conveyor/run-scorecards.json`) are never edited.

### Merge notes for #3908 (2026-09-22)

Trial merges ran in the scratch dir with `git merge-file -p main base branch`. Base is `ca7e68b71`, main is `origin/main`, branch is `ff1618065`. No checkout was touched.

> **Base caveat:** `git merge-base --all` returns two bases: `ca7e68b71` and `21aaedb0b`. The branch also merged main at `4261ef224` (`d5a9dc0d0`), and several commits were cherry-picked onto both sides (#3331, #3634, #3704, #3383 round-cap). For `we:scripts/conveyor/reconcile-fix-dispatch.mjs`, use branch `1024822db` as the effective base. It is byte-identical to main `8ab3e976e`, and it cuts the conflicts from 17 to 5. For the other files, `ca7e68b71` is fine.

---

#### 1. `we:scripts/conveyor/advisory-round-count.mjs`: add/add
- **Main:** `4a1ce7b12`, the #3383 round-cap port. It created the file.
- **Branch:** `04380c304`, the #3383 slice. It created the same file.
- **Trial merge:** add/add, so there is no real base. The code is identical once comments are stripped (verified). Only the header prose differs: main cites #2117 (33 comments) and #2298; the branch cites #2117 (6 runs).
- **Resolution:** keep main's file unchanged. Optionally carry over the branch's extra note that `operations → conveyor` imports already have a precedent.
- **Dependencies:** none.

#### 2. `we:scripts/conveyor/reconcile-core.mjs`: 2 conflicts, both comment-only
- **Main:**
  - `4a1ce7b12`: advisory count unioned into `attempts`.
  - `f211888d0`: multi-repo. `bindAgents(pr, agents, repo)`, `planReconcile({repo})`, and repo-aware `reviewSessionSlug` / `sessionSlugFor`.
  - `db45af23a`: `assessLiveness` filters `state:'done'` sessions (recycled-pid fix).
  - `dd3b24bec`: doc pointers to clear-stuck-session.
- **Branch:**
  - `04380c304`: the same advisory union.
  - `8cb872a96`: `needs-human` moves from `OWED_ELSEWHERE` into `OWED` as `'review'`. Every `review:human` PR now gets the advisory panel. The `selectStatusCandidates` doc is updated to match.
- **Conflict 1** is the comment above `import { countAdvisoryComments }`. Take main's; the import line itself is shared.
- **Conflict 2** is the comment above `const attempts = Math.max(...)` in `planReconcile` REFUSAL 3. Take the branch's text, because it explains the `needs-human` population that the `OWED` change now dispatches. The code below the comment is identical on both sides.
- **Clean-merged, check it is present:** `OWED` includes `'needs-human': 'review'`. The `OWED_ELSEWHERE` entry for `needs-human` is removed. Main's `repo` threading and `isFinished` filter are kept.
- **#3437 survives:** `bindAgents` path 2 (bind by session name) stays as main has it: `slugs = [reviewSessionSlug(prNumber, repo), sessionSlugFor(prNumber, 'fix', null, '', repo)]`. The branch never touched `bindAgents`. Do not take the branch's copy of this function; its body lacks `repo`.
- **Dependencies:** none new.
- **Risk: tests.** `8cb872a96` changes behaviour. Main's `we:scripts/conveyor/__tests__/reconcile-core.test.mjs` may still expect `needs-human` → `owed-elsewhere`. Port the branch's test diff for this file together with it.
- **Risk: uncapped re-dispatch.** In REFUSAL 2 (`findings === 0`), `review` is pushed with `attempts: 0` and no cap check. A `needs-human` PR whose advisory comments do not count as findings would get a review every tick while nothing live is bound to it. It is bounded only by the action-store hold (see file 4). This is branch behaviour; carry it over as is, but note it on the card.

#### 3. `we:scripts/conveyor/reconcile-pass.mjs`: 1 conflict
- **Main:**
  - `9c828db99` / `1b3893de5`: `--prs-file` / `--agents-file` overrides via `readPrsFromFile`.
  - `f211888d0`: `repoKey` validation, `planReconcile({repo: repoKey, ...})`, and `execFileSyncThrottled`.
- **Branch:**
  - `04380c304`: `durableCountsFrom` takes `Math.max(countRearmComments, countAdvisoryComments)`.
  - `2acd6c567`: opt-in `queueScope` via `scopePrsToQueue`.
- **Conflict** is in `runReconcilePass`, where the PR list is read. Keep **both**: main's two `repoKey` lines, then `const prs = scopePrsToQueue(readPrs({ repo }), { label: 'reconcile-pass', ...queueScope });`. Taking the branch side alone parses fine but throws `ReferenceError: repoKey` at runtime.
- **Dependencies:** `we:scripts/conveyor/queue-scope.mjs` is branch-only and must land first or together. `we:scripts/conveyor/advisory-round-count.mjs` is already on main.
- **Risk:** none beyond that. The advisory union here is redundant with reconcile-core's own union, but harmless.

#### 4. `we:scripts/conveyor/reconcile-fix-dispatch.mjs`: 5 conflicts (effective base `1024822db`), plus 2 clean-merge bugs
- **Main:**
  - `138d2e372`: PR-diff fallback only when `item` resolved, plus `isSafeFallbackScopeEntry`.
  - `8afdfed9a` / `e6f481d42`: `fetchPrDiffScope` uses `--repo` and `execFileSyncThrottled`.
  - `f211888d0`: `repoKey`. Non-WE fix/ci-heal returns early as `unsupported-repo` (recorded via `we:scripts/conveyor/unsupported-repo.mjs`). `repo='we'` guard in `tryResumeFix`/`dispatchFix`. Repo-aware `sessionSlugFor`. `--prs-file` support.
- **Branch:**
  - `08ff516f3`: PRs with no item number are no longer refused. Attribution becomes `PR #<n>`, via `attributionKind`/`attributionNum` and `ITEM_NUM:''`.
  - `0c4167849`: `guardedDispatch` / action store around both the resume and the fresh spawn. A failed resume now returns `held:indeterminate` instead of falling through to a fresh dispatch. A held result becomes a `held` refusal and the lane goes back via `lanes.unshift`.
  - `0f1d0fb8f`: `decideDispatchRoute`, and `routing` on the result.
  - `a4960b51b`: `size` carried through; new `fetchPrDiffLoc` (the `measured-diff` step).
- **Conflicts:**
  1. **Imports:** keep both sets (`repoKeyForSlug`, `execFileSyncThrottled`, plus `guardedDispatch`, `createActionStore`, `actionResource`, `DRIVER_ID`).
  2. **`planFixesFromReconcile` docblock:** take the branch's text. `no-item-num` is no longer a refusal.
  3. **`tryResumeFix` `expectedNames`:** combine them as `new Set([...(planned.itemNum ? [sessionSlugFor(planned.itemNum,'build')] : []), sessionSlugFor(planned.pr,'fix',null,'',repo)])`.
  4. **`tryResume` call in `runReconcileFixDispatch`:** `tryResume(entry, { root, repo: repoKey, actions })`.
  5. **`dispatch` call:** the branch's held-handling block, with `repo: repoKey` instead of `entry.repo ?? repo ?? 'we'`. The CLI `--repo` is a slug such as `chalbert/web-everything`, and main's `repo !== 'we'` guard would throw on it.
- **Clean-merge bug A:** `tryResumeFix` and `dispatchFix` each end up with **two `repo` parameters**: main's `repo = 'we'` and the branch's `repo = planned.repo ?? 'we'`. Result: `SyntaxError: Duplicate parameter name` (verified with `node --check`). Keep main's `repo = 'we'`, since it holds a repo key. Keep the branch's `now`, `actions`, `owner` on the same line. `actionResource(repo, …)` accepts the key: `normalizeRepo` maps `'we'`.
- **Clean-merge bug B:** in the planning loop, main's `if (item && !scope.length)` survives. It skips the PR-diff fallback when `item` is null. That blocks the branch's no-item path: those PRs still end up as `no-scope`, so `08ff516f3` is silently neutralised. Change it to `if ((item || !itemNum) && !scope.length)`, which preserves the branch's behaviour. That runs the fallback for a resolved item or for no item number at all. An unresolvable number (ghost card) still gets refused, which keeps main's #3634 review rule. Keep main's `isSafeFallbackScopeEntry` filter.
- **`fetchPrDiffLoc`:** port it as the branch has it (raw `execFileSync`, no `--repo`). Faithful port; see Follow-ups.
- **Dependencies:**
  - Branch-only: `we:scripts/operations/action-dispatch.mjs`, `we:scripts/operations/action-store.mjs`, `we:scripts/operations/action-record.mjs`, `we:scripts/operations/tick-mutex.mjs`, `we:scripts/lib/dispatch-contracts.mjs` (and `we:scripts/lib/dispatch-task-type.mjs`, which it uses).
  - `defaultReadScorecards` and `defaultReadSizePolicy` exist only in the branch's `we:scripts/operations/dispatch-lane-io.mjs`.
  - The no-item path also needs the branch's `BRIEF_REQUIRED_BY_KIND.fix` (+`ATTRIBUTION_KIND`, `ATTRIBUTION_NUM`) in `we:scripts/operations/dispatch-lane.mjs`, and `we:skills-src/conveyor/fix-agent-brief.md` with its 8 `ATTRIBUTION_*` tokens. Main has neither. Without them, `fillBrief` refuses or leaves tokens unfilled.

#### 5. `we:scripts/operations/review-dispatch.mjs`: 9 conflicts (same with base `4261ef224`)
- **Main:**
  - `f211888d0`: multi-repo `planReviewDispatch`: `repoKeyForSlug`, `laneRepo`, a check that the checkout exists, and `reviewSessionSlug(prNum, repoKey)`. `LANE_REPO` brief placeholder. `repoKey` on the result.
  - #3704 review fixes: `TOOL_FREE_ONLY_JUDGE_PROVIDERS = ['codex']` guard inside `dispatchReview`.
  - `acbc4c425` / `3225ed6fb`: `assertMainNotStale` moved into `we:scripts/lib/main-staleness.mjs` and re-exported. The branch never modified that function (verified), so main's extraction wins cleanly.
- **Branch:**
  - `02d9af300`: the CLI becomes `dispatchReviewCli`. The default is the **mechanical** `dispatchReviewMechanical` (synchronous, no `claude` session); `--agent` is opt-in. `CODEX_JUDGE_PROVIDER_REFUSAL`. `--codex-advisory`, `--correctness-advisory`, `--antigravity-review`.
  - `9d55b18ef` / `04380c304`: `runAutoFixRoute` (autofix for parked `review:human` PRs, plus a decline note).
  - `0c4167849`: `guardedDispatch` on both paths; exit 75 when held.
  - `0f1d0fb8f` / `15d003432`: `reviewDispatchRoute` and `reviewSeatRoutes` (per-lens `selectProvider`); `routing` on the result.
- **Conflicts:**
  1. **Imports (top):** keep both (`repoKeyForSlug`, `CONSTELLATION_REPOS`, plus the action-store imports).
  2. **`dispatch-lane-io` import and the import block after it:** the branch's list (adds `defaultReadScorecards`), plus all branch imports. Keep main's `homedir` / `existsSync`, which clean-merge above.
  3. **Placeholders:** keep **main's** `REVIEW_BRIEF_PLACEHOLDERS` including `'LANE_REPO'`. Main's brief uses `{{LANE_REPO}}` twice; dropping it leaves the token literal. Keep `TOOL_FREE_ONLY_JUDGE_PROVIDERS`: main's test imports it. Once cli-adapter graduates, point it at `TOOL_FREE_JUDGE_PROVIDER_NAMES` so `antigravity` is refused too.
  4. **`dispatchReview` JSDoc `@param`s:** union of both.
  5. **Codex JSDoc:** take main's wording.
  6. **`dispatchReview` destructure:** keep both (`checkoutExists`, `home`, `readScorecards`, `now`, `actions`, `owner`).
  7. **Body:** keep main's TOOL_FREE guard and main's `fillReviewBrief` with `LANE_REPO`. **Delete** the branch's `const planned = planReviewDispatch({ pr, repo: normalizeRepo(repo) })`: main already declares `planned` above it, and a second one is a `SyntaxError` (verified).
  8. **Spawn and return:** wrap the spawn in the branch's `guardedDispatch`, with `actionResource(planned.repo, …)`. Return the union: main's `repoKey`, plus the branch's `routing` and `judgeProvider`.
  9. **CLI:** take the branch's `dispatchReviewCli` whole; main's inline CLI body becomes its `--agent` arm. In the mechanical arm, change `reviewSessionSlug(flag('pr'))` to `reviewSessionSlug(flag('pr'), repoKeyForSlug(flag('repo')) ?? 'we')`. That keeps main's multi-repo slug naming; it is only evidence data. Keep `IS_CLI` → `runAutoFixRoute`.
- **Dependencies (branch-only):**
  - `we:scripts/operations/action-dispatch.mjs`, `we:scripts/operations/action-store.mjs`, `we:scripts/operations/action-record.mjs`, `we:scripts/operations/tick-mutex.mjs`.
  - `we:scripts/lib/dispatch-task-type.mjs`, `we:scripts/lib/dispatch-contracts.mjs`.
  - `we:scripts/operations/review-dispatch-wrapper.mjs`, `we:scripts/conveyor/autofix-review-findings.mjs`.
  - Symbols main lacks: `TOOL_FREE_JUDGE_PROVIDER_NAMES` and `antigravity` in `JUDGE_PROVIDER_NAMES` (`we:scripts/operations/cli-adapter.mjs`), and `defaultReadScorecards` (`we:scripts/operations/dispatch-lane-io.mjs`).
  - `MANDATORY_LENSES` (jury-core) and `selectProvider` (`we:scripts/lib/provider-routing.mjs`) already exist on main. Nothing the branch uses was renamed or removed by main.
- **Risk: #3437 does not apply to the mechanical path.** The mechanical default spawns no `claude` session, so reconcile-core's name bind never sees a live review. The only guards against a second concurrent review of the same PR are `guardedDispatch` (resource `repo#pr:N`, shared by `kind:'review'` and `'fix'`, so review and fix also exclude each other) and the tick mutex. If the action store is missing or unavailable, `guardedDispatch` returns `held:'unavailable'`, which fails closed. If `runId` is null, the record stays `dispatching` and later ticks are held until the lease/absence grace ends (10 + 15 min).
- **Risk: multi-repo loss on the default path.** `we:scripts/operations/review-dispatch-wrapper.mjs#planReviewDispatchWrapper` accepts any `owner/repo`, uses `reviewSessionSlug(prNum)` with no repo, and acquires a **WE** lane. So a FUI or plateau-app review runs in a WE lane, and main's checkout check and `unsupported-repo` error never fire. Main's runner parses the `unsupported-repo` text in stderr. Raise this against the wrapper card; it is not solvable in this file.
- **Risk: staleness guard.** Main's #3474 staleness guard runs only on the `--agent` path. The mechanical default skips it; the branch behaves the same way.
- **Risk: runner coupling.** Main's `we:skills-src/conveyor/runner.mjs` calls this CLI with a blocking `exec` and no heartbeat. The mechanical default now blocks for the whole review. Land this together with or after the runner card's #3629 heartbeat change.

---

#### Worker steps
1. Land the prerequisites first, or in the same PR: action-dispatch/store/record, tick-mutex, dispatch-contracts, dispatch-task-type, queue-scope, review-dispatch-wrapper, autofix-review-findings, plus the branch's `we:scripts/operations/cli-adapter.mjs`, `we:scripts/operations/dispatch-lane-io.mjs`, `we:scripts/operations/dispatch-lane.mjs`, `we:skills-src/conveyor/fix-agent-brief.md` and the runner deltas.
2. `we:scripts/conveyor/advisory-round-count.mjs`: no change (keep main's).
3. `we:scripts/conveyor/reconcile-core.mjs`: apply the `8cb872a96` `OWED` / `OWED_ELSEWHERE` / doc diff. Swap in the branch's REFUSAL-3 comment. Leave `bindAgents`, the `repo` threading and `isFinished` exactly as main has them.
4. `we:scripts/conveyor/reconcile-pass.mjs`: add the `countAdvisoryComments` and `scopePrsToQueue` imports, the `durableCountsFrom` union, and the `queueScope` param. Keep main's `repoKey` lines ahead of the scoped `readPrs`.
5. `we:scripts/conveyor/reconcile-fix-dispatch.mjs`: diff `1024822db..ff1618065` and apply it to main. Resolve the 5 conflicts as above. Deduplicate the `repo` parameter (keep `repo='we'`). Widen the fallback gate to `(item || !itemNum)`. Pass `repoKey` (not a slug) to `tryResume`/`dispatch`. Port `fetchPrDiffLoc` exactly as the branch has it.
6. `we:scripts/operations/review-dispatch.mjs`: apply the 9 resolutions above. Delete the branch's duplicate `planned`. Keep `LANE_REPO` and `TOOL_FREE_ONLY_JUDGE_PROVIDERS`. Pass a repo-aware slug in the CLI's mechanical evidence.
7. Port the branch's test diffs for all five files: `we:scripts/conveyor/__tests__/reconcile-core.test.mjs`, `we:scripts/conveyor/__tests__/advisory-round-count.test.mjs`, `we:scripts/operations/__tests__/review-dispatch.test.mjs`, and the reconcile-fix-dispatch/routing suites. Keep main's `TOOL_FREE_ONLY` and `LANE_REPO` cases.
8. Verify: `node --check` all five files, run vitest on the conveyor and operations suites, and run `check:standards`. Grep that `reviewSessionSlug(prNumber, repo)` is still in `bindAgents` (#3437), and that no function has a duplicate `repo` parameter.

#### Follow-ups (not in this port)
- `we:scripts/conveyor/reconcile-fix-dispatch.mjs#fetchPrDiffLoc`: switch to `execFileSyncThrottled` and pass `--repo` when set, matching main's `fetchPrDiffScope` (the #3860 throttle and #3634 multi-repo guards).

### Landing order note (designer, 2026-09-22)

This slice makes the mechanical review path the default for `we:scripts/operations/review-dispatch.mjs`, which blocks for the whole review. Main's current `we:skills-src/conveyor/runner.mjs` calls that CLI with a blocking exec and no heartbeat until #3487 lands. **Between this slice landing and #3487 landing, the conveyor runner must not run continuously on main** (pause it, or land the two back to back). #3487 carries the same note.

### Addendum: snapshot moved to 600acc14f (2026-09-23)

`we:` prefixes below are repo-relative paths. Base `ca7e68b71`, main = `origin/main`, branch = `600acc14f`,
matching the existing note's setup.

**`we:scripts/operations/review-dispatch.mjs`** — **9 conflicts**, the SAME count as the existing note, but
this is coincidence, not stability: conflict #1 (imports, old resolution "keep both … repoKeyForSlug/
CONSTELLATION_REPOS/repoProfile + action-dispatch/action-store/action-record/tick-mutex") and conflict #9
(the CLI, old resolution "take the branch's `dispatchReviewCli` whole") are now each substantially LARGER,
absorbing a big new branch feature — **Rule 7 of #3690 (#3887)**:
- New imports to union in at conflict #1: `independentReviewDepthFor` (from `we:scripts/lib/dispatch-contracts.mjs`,
  #3897's scope), `SUPERVISION_LEVELS` (from `we:scripts/lib/provider-routing.mjs`, #3897's scope),
  `FLOOR_MAX_FINDINGS`/`recordFloorRun` (from `we:scripts/lib/jury-core.mjs`, this card's own scope), `driveRun`
  (from `we:scripts/operations/cli-adapter.mjs`), and `startRun`/`createRegistry`/`createFileRunStore`/`newRunId`/`fileItemOperation`/
  `FILE_ITEM_OP`/`createFileItemReader`/`createFileItemSinks` (the declared `file-item` operation's own pieces —
  all already on main).
- New exported functions (added to the file body, outside any conflict region — these merge clean):
  `reviewSeatRoutes(...)` now takes a `supervision = SUPERVISION_LEVELS.FULL` param and, at `spot-check`
  depth, returns a single `floorSeatRoute(...)` instead of the mandatory-lens fan-out; `fileFloorFindingFollowUp(...)`
  drives the declared `file-item` operation (registry → `startRun` → `driveRun`) to file the `#3313`
  "every review owes a follow-up" card for a floor finding; `runFloorPass(...)` ties the two together.
- **Open question to verify before landing, not resolvable from a text diff alone**: `runFloorPass` is
  DEFINED but has **no caller anywhere else in this file** at `600acc14f` (confirmed by grep — `reviewSeatRoutes`'s
  own call site inside `dispatchReview`, `routing: reviewSeatRoutes({ scorecards: readScorecards(root) })`,
  never passes `supervision`, so it stays at the `FULL` default and the floor path is never reached from here).
  Either the branch wires supervision-aware review from elsewhere this diff doesn't touch, or #3887's floor
  pass ships as an unwired primitive on the prototype and needs its own activation card. Confirm which before
  writing this into #3908's worker steps as "done" — a faithful, no-behaviour-change port is safe either way,
  but the card's Done-when should say explicitly whether the floor pass is reachable after this lands.
- The other 7 conflicts (dispatch-lane-io import block, REVIEW_BRIEF_PLACEHOLDERS/TOOL_FREE_ONLY_JUDGE_PROVIDERS,
  `dispatchReview` JSDoc/destructure, the Codex JSDoc, the spawn+return block) are unchanged in nature and
  resolution from the existing note, just shifted.

**`we:scripts/operations/__tests__/review-dispatch.test.mjs`** — **10 conflicts** (the existing note only listed
this file in worker step 7 as "port the branch's test diffs", with no count). Not individually triaged here
given the size, but expect most of it to be new `#3887`/floor-pass test additions plus the same #3846/#3704
seat-routing tests the old note's other four test files already describe as "keep both, appended blocks."
Recommend triaging this file's conflicts alongside the `runFloorPass` wiring question above, since its own
test fixtures may answer whether `supervision` is meant to reach `reviewSeatRoutes` from a real call site yet.

**Worker steps (add to the existing list)**
9'. Before finalizing conflict #1 and #9 resolutions, union in the `#3887` imports/exports described above.
10. Confirm (against the branch's own test suite and #3690's slice plan) whether `runFloorPass`/the
    `supervision`-aware `reviewSeatRoutes` call is wired to a real caller on the prototype, or ships unwired;
    record the answer in this card's Done-when rather than assuming either way.

- Moved here from #3901 (2026-09-24): `we:scripts/operations/__tests__/action-ground-truth.test.mjs`, which imports `we:scripts/operations/review-dispatch-wrapper.mjs`, a module this slice ports.
- Moved here from #3895 (2026-09-24, at #3895 land time): `we:scripts/operations/__tests__/telemetry-wiring.test.mjs`, which imports `we:scripts/operations/review-dispatch-wrapper.mjs` (this slice's own scope), `we:scripts/operations/minimal-context-provider.mjs` (#3902) and the prepare wrappers (#3905). Per the epic's critical path (`#3897 → #3902 → #3906 → #3903 → #3904 → #3908`) and #3905's own `blockedBy: 3903`, both #3902 and #3905 will already be on `main` by the time this slice lands — this is the correct last-landing home for the test's full dependency set. #3895 itself ported `we:scripts/operations/telemetry-store.mjs`, which this test also exercises.

## Graduation import check

- 2026-09-24: graduation-import-check added blockedBy #3905 — the moved-in `we:scripts/operations/__tests__/telemetry-wiring.test.mjs` also imports a module #3905 owns.
- 2026-09-24: graduation-import-check moved `we:scripts/operations/__tests__/telemetry-wiring.test.mjs` here from #3895 — it imports a module this card owns.
