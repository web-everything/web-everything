---
bornAs: xbunbsg
kind: story
size: 5
parent: "3443"
status: open
blockedBy: ["3902", "3901", "3897"]
scope: ["we:scripts/__tests__/dispatch-routing-table.test.mjs", "we:scripts/lib/__tests__/dispatch-supervisor.test.mjs", "we:scripts/operations/__tests__/dispatch-abort.test.mjs", "we:scripts/operations/__tests__/dispatch-crosses-processes.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-defaults.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-marker-freshen.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-prepare-wiring.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-routing-record.test.mjs", "we:scripts/operations/__tests__/dispatch-lane.test.mjs", "we:scripts/operations/__tests__/dispatch-provider-registry.test.mjs", "we:scripts/operations/__tests__/dispatch-sinks-root-hermeticity.test.mjs", "we:scripts/operations/__tests__/dispatch-spawn-live.test.mjs", "we:scripts/operations/__tests__/dispatch-task.test.mjs", "we:scripts/operations/__tests__/run-store.test.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/dispatch-lane.mjs", "we:scripts/operations/dispatch-provider-registry.mjs", "we:scripts/operations/dispatch-providers/__tests__/ci-heal-dispatch-routing.test.mjs", "we:scripts/operations/dispatch-providers/build.mjs", "we:scripts/operations/dispatch-providers/ci-heal.mjs", "we:scripts/operations/dispatch-providers/fix.mjs", "we:scripts/operations/dispatch-providers/prepare-decision.mjs", "we:scripts/operations/dispatch-providers/prepare.mjs", "we:scripts/operations/dispatch-task-io.mjs", "we:scripts/operations/dispatch-task.mjs", "we:scripts/operations/effect-executor.mjs", "we:scripts/operations/run-record.mjs", "we:scripts/operations/run-store.mjs", "we:scripts/operator/dispatch.mjs", "we:scripts/operations/__tests__/inflight-fail-closed.test.mjs", "we:scripts/operations/run.mjs", "we:scripts/operations/__tests__/http-adapter.test.mjs", "we:scripts/operations/delivery-agent-marker.mjs", "we:scripts/operations/__tests__/delivery-agent-marker.test.mjs", "we:scripts/operations/wake.mjs", "we:scripts/operations/__tests__/wake-cli.test.mjs", "we:scripts/operations/explore-io.mjs", "we:scripts/operations/__tests__/explore.test.mjs", "we:scripts/operations/runner-activity-io.mjs"]
dateOpened: "2026-09-22"
tags: []
---

# Graduate dispatch path: dispatch-lane changes, dispatch providers and registry, dispatch-task from lane/mechanical-dispatcher to main

Ports 14 files (we:scripts/operations/dispatch-lane.mjs, we:scripts/operations/dispatch-lane-io.mjs, we:scripts/operations/dispatch-provider-registry.mjs, we:scripts/operations/dispatch-providers/build.mjs, we:scripts/operations/dispatch-providers/ci-heal.mjs, we:scripts/operations/dispatch-providers/fix.mjs, we:scripts/operations/dispatch-providers/prepare.mjs, we:scripts/operations/dispatch-providers/prepare-decision.mjs, we:scripts/operations/dispatch-task.mjs, we:scripts/operations/dispatch-task-io.mjs, we:scripts/operations/effect-executor.mjs, we:scripts/operations/run-record.mjs, we:scripts/operations/run-store.mjs, we:scripts/operator/dispatch.mjs) plus their tests. On the critical path. we:scripts/operations/dispatch-lane-io.mjs is imported by ~25 modules and main also changed it: diff-merge. Main also changed these files, so each gets a diff-merge: we:scripts/operations/dispatch-lane-io.mjs, we:scripts/operations/dispatch-lane.mjs. Graduation slice of epic #3443 (see its Slice procedure). FAITHFUL PORT: no behaviour change while porting; the branch code lands as-is (operator, 2026-09-22). Port from snapshot 600acc14f of origin/lane/mechanical-dispatcher. For every file main has changed since the merge base ca7e68b71 (check with git log ca7e68b71..origin/main -- <file>), apply the branch diff onto main's current file; never copy the branch file over it. Add only this slice's own lines to we:scripts/operations/run.mjs and the we:scripts/operations/__tests__/http-adapter.test.mjs pin (append-only, so parallel slices merge cleanly). Full gate on main's tree: check:standards, test, smoke. Hold lifted 2026-09-24: the #3857 model-tier table passed a live probe and the operator started wave A.

## Done when

1. **Executable** — `npx vitest run we:scripts/__tests__/dispatch-routing-table.test.mjs we:scripts/lib/__tests__/dispatch-supervisor.test.mjs we:scripts/operations/__tests__/dispatch-abort.test.mjs we:scripts/operations/__tests__/dispatch-crosses-processes.test.mjs we:scripts/operations/__tests__/dispatch-kind-axes.test.mjs we:scripts/operations/__tests__/dispatch-lane-build-wiring.test.mjs we:scripts/operations/__tests__/dispatch-lane-ci-heal-wiring.test.mjs we:scripts/operations/__tests__/dispatch-lane-defaults.test.mjs we:scripts/operations/__tests__/dispatch-lane-fix-wiring.test.mjs we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs we:scripts/operations/__tests__/dispatch-lane-marker-freshen.test.mjs we:scripts/operations/__tests__/dispatch-lane-prepare-decision-wiring.test.mjs we:scripts/operations/__tests__/dispatch-lane-prepare-wiring.test.mjs we:scripts/operations/__tests__/dispatch-lane-routing-record.test.mjs we:scripts/operations/__tests__/dispatch-lane.test.mjs we:scripts/operations/__tests__/dispatch-provider-registry.test.mjs we:scripts/operations/__tests__/dispatch-sinks-root-hermeticity.test.mjs we:scripts/operations/__tests__/dispatch-spawn-live.test.mjs we:scripts/operations/__tests__/dispatch-task.test.mjs we:scripts/operations/__tests__/run-store.test.mjs we:scripts/operations/dispatch-providers/__tests__/ci-heal-dispatch-routing.test.mjs we:scripts/operations/__tests__/inflight-fail-closed.test.mjs we:scripts/operations/__tests__/http-adapter.test.mjs we:scripts/operations/__tests__/delivery-agent-marker.test.mjs we:scripts/operations/__tests__/wake-cli.test.mjs we:scripts/operations/__tests__/explore.test.mjs` passes on main's tree (all of this slice's tests; each fails before the port because its module is missing or differs).
2. **Executable** — `npm run check:standards` reports 0 errors, and the PR's required `test` and `smoke` checks are green.
3. **Faithful port** — for each ported file, `git diff 600acc14f -- <file>` (prototype snapshot vs main after the port) shows only main's own later changes kept by the merge notes, never a behaviour change of the branch code; runtime data files (e.g. `we:scripts/conveyor/run-scorecards.json`) are never edited.

### Merge notes for #3906 (2026-09-22)

Merge base `ca7e68b71`. Conflict counts are from `git merge-tree` (the real 3-way result); single-base `ca7e68b71` counts in [brackets] where they differ.

**Designer rulings applied:** take the branch's throw in `defaultClaudeProvider`; keep main's `buildAgentArgv` argv with no `--session-id`.

**`we:scripts/operations/dispatch-lane-io.mjs`**
- Main: #3331 real `--bg` session id (`4ea206ce2` — `buildAgentArgv` drops `--session-id`; `defaultClaudeProvider` returns `parseBackgroundedId(stdout) || request.sessionId`; `listedSessionIds` also collects `id`); #3567 investigation kind; #3694 dispatch-eligibility (`raw.admission`).
- Branch: its own parallel #3331 fix (new `parseBackgroundedHandle` hex prefix, `isHandleListed` prefix match, `defaultClaudeProvider` **throws** on unparseable output); `WE_DISPATCH_KIND` on the spawn env; `spawnAgentToCompletion`; provider-registry routing (`routeDispatchProvider`, `pid:` detached handles, `isDispatchHandleLive`, `wrapper-pid` liveness source); action store / `guardedDispatch` / tick mutex (`actions`, `repo`, `owner`, `freshenCheckout` sink options); #3717/#3843 routing (`decideDispatchRoute`, `defaultReadScorecards`, `defaultReadSizePolicy`, `size` on items); #3840 `readItemDeliveryAgentOverride`; #3848 executed vendor.
- Trial merge: **7 conflicts** [6]:
  1. ~L859 `findItem` item shape — main side empty, branch adds `...size` spread → **take branch**.
  2. ~L1200 sink docblock "THE HANDLE…" → take branch text, but delete its sentence saying "`mintSessionId` and `--session-id` in the argv are kept" (contradicts ruling).
  3. ~L1244 "PROVEN AGAINST…" → take main (real-CLI 2.1.269 verification).
  4. ~L1279 provider-port paragraph → take branch.
  5. ~L1463 `defaultClaudeProvider` docblock → take branch (throw rationale).
  6. ~L1496 `defaultClaudeProvider` body → **take branch** (`WE_DISPATCH_KIND` env + `parseBackgroundedHandle` + throw); the env stamp is load-bearing for the guard-bash deny.
  7. ~L1577 `buildAgentArgv` docblock → **take main**. The code already auto-merged to main's argv (no `--session-id`), enforced by main's `we:scripts/operations/__tests__/dispatch-lane.test.mjs` ~L701 and `we:scripts/operations/__tests__/dispatch-spawn-live.test.mjs` ~L70.
- Silent auto-merges to eyeball: `listedSessionIds` keeps main's `sessionId`+`id`; `stampLiveness`/`readTick` use branch `isDispatchHandleLive` prefix matching (works with main's short-id handles); fix the stray indentation on the `...inFlight,` line in the `stampLiveness` return.
- Dependencies (branch-only): `we:scripts/operations/action-dispatch.mjs`, `we:scripts/operations/action-store.mjs`, `we:scripts/operations/action-record.mjs`, `we:scripts/operations/tick-mutex.mjs`, `we:scripts/operations/session-role.mjs`, `we:scripts/lib/spawn-to-completion.mjs`, `we:scripts/operations/detached-dispatch.mjs`, `we:scripts/lib/dispatch-contracts.mjs`, `we:scripts/operations/delivery-agent-marker.mjs` (this card), `we:scripts/operations/dispatch-provider-registry.mjs`, `we:scripts/operations/dispatch-providers/{build,fix,ci-heal,prepare,prepare-decision}.mjs`. Nothing imported was renamed/removed on main (lease-reaper, pr-watch, queue-store, poc-branches exports all present).
- Main-side importers (19). Every export signature change is additive (new optional params), so nothing breaks at import. Behaviour changes that reach callers:
  - `we:scripts/operations/run.mjs` and `we:scripts/operations/ci-heal-pr-dispatch.mjs` → `createDispatchSinks` default provider is now `routeDispatchProvider`: `build`/`ci-heal`/`fix`/`prepare*` launches go to **detached mechanical providers**, not `claude --bg`. ci-heal-pr-dispatch already passes `actions`/`repo` (ignored on main today, activates `guardedDispatch` after). Branch we:scripts/operations/run.mjs also passes `freshenCheckout` (we:scripts/operations/run.mjs owned elsewhere).
  - `we:scripts/operations/runner-activity-io.mjs` → `stampLiveness` return now spreads `...inFlight` and can report `livenessSource: 'wrapper-pid'` (harmless); run-store root move handled below.
  - `we:scripts/operations/wake.mjs` → handled below.
  - Throw-instead-of-fallback: main's `we:scripts/operations/__tests__/dispatch-liveness-hardening.test.mjs` ~L399 asserts the fallback and must be updated.
  - Unaffected: `we:scripts/operations/review-dispatch.mjs` and `we:scripts/conveyor/reconcile-fix-dispatch.mjs` (`parseBackgroundedId` unchanged).

**`we:scripts/operations/dispatch-lane.mjs`**
- Main: `mintSessionSlug`/`PR_KINDS` multi-repo slugs (`f211888d0`), #3567 investigate, #3694 `admission.held` hold reason.
- Branch: `ATTRIBUTION_KIND`/`ATTRIBUTION_NUM` placeholders (no-item-number fix), `assertDispatchKindAxesDisjoint` + wrapper-owned kind axes, `taskTypeFor` routing (#3717), shared-state tick.
- Trial merge: **5 conflicts** [4]: (1) `BRIEF_PLACEHOLDERS` → add branch's `'ATTRIBUTION_KIND', 'ATTRIBUTION_NUM'`; (2) `BRIEF_REQUIRED_BY_KIND.fix` → take branch line; (3) after `LAUNCH_KINDS` → take branch's whole added block including the `assertDispatchKindAxesDisjoint()` call; (4) `sessionSlugFor` → **keep main's `mintSessionSlug`** (byte-identical to branch literals for `repo='we'`); (5) not-cleared `holdReason` → **keep main's `raw.admission?.held` branch**.
- Dependency: `we:scripts/lib/dispatch-task-type.mjs` (branch-only); keep main's session-slug import.

**`we:scripts/operator/dispatch.mjs`**
- Main: `--disallowedTools` in the spawn argv (`9d5a8c2dd`). Branch: SUPERSEDED header + `env: markWorkerEnv(process.env)`.
- **1 conflict** at the `spawnFn('claude', …)` call: keep main's argv, add the branch's `env: markWorkerEnv(process.env)`. Needs `we:scripts/operations/session-role.mjs`.

**`we:scripts/operations/wake.mjs`**
- Main: untouched. Branch (2 commits): imports `isHandleListed` and swaps `listed.has(handle)` for `isHandleListed(handle, sessions)` (short-id prefix match). **0 conflicts** — apply branch diff. Note it still never matches a `pid:` handle; that is the branch's behaviour, ported as-is.

**`we:scripts/operations/explore-io.mjs`**
- Main: untouched. Branch (2 commits): `investigatorSessionName` export; liveness also matches a listed session by `name`; unreadable-listing guard accepts `name`. **0 conflicts** — apply branch diff.

**`we:scripts/operations/delivery-agent-marker.mjs`**
- New file (branch-only). Imports `we:scripts/backlog/frontmatter.mjs`, `we:scripts/lib/main-staleness.mjs`, `we:scripts/operations/resolve-io.mjs` (all on main) and `we:scripts/operations/detached-dispatch.mjs` (branch-only). Copy as-is.

**`we:scripts/operations/runner-activity-io.mjs`** (main-only file)
- Scope per ruling: follow the run-store root move only. It builds its store from `env.OPERATION_RUNS_DIR || runsDir(root)` (L38) and reports `historySource` the same way (L129); switch both to `resolveRunsDir()` so it reads the coordination root that dispatch now writes. No other change.

**Small files (main untouched unless noted, clean apply)**
- `we:scripts/operations/effect-executor.mjs`: `inFlight({dispatch})` + action-record hold path.
- `we:scripts/operations/run-store.mjs`: needs `we:scripts/operations/coordination-root.mjs` (branch-only). `resolveRunsDir` moves to `~/workspace/.operations/coordination/runs` (override `WE_COORDINATION_ROOT`); existing checkout-local run records are not migrated.
- `we:scripts/operations/run-record.mjs`: main added #3521 cache-hit work; branch adds `transcriptFile` to `TELEMETRY_STRINGS`. **0 conflicts**.

**Worker steps**
1. Land branch-only dependencies first (or confirm their cards landed): action-*, tick-mutex, session-role, coordination-root, spawn-to-completion, detached-dispatch, dispatch-contracts, dispatch-task-type, dispatch-provider-registry, `we:scripts/operations/dispatch-providers/`.
2. Copy `we:scripts/operations/delivery-agent-marker.mjs`.
3. Apply effect-executor, run-store, run-record branch diffs.
4. Hand-merge `we:scripts/operations/dispatch-lane.mjs` (5 conflicts as above).
5. Hand-merge `we:scripts/operations/dispatch-lane-io.mjs` (7 conflicts) per the ruling: branch throw + `WE_DISPATCH_KIND` in `defaultClaudeProvider`, main's argv without `--session-id`; make docblocks agree with that code.
6. Merge `we:scripts/operator/dispatch.mjs` (1 conflict).
7. Apply branch diffs for `we:scripts/operations/wake.mjs` and `we:scripts/operations/explore-io.mjs` (0 conflicts each).
8. Edit `we:scripts/operations/runner-activity-io.mjs` to read runs via `resolveRunsDir()` (both L38 and L129 sites).
9. Update main tests that pin old behaviour: fallback test in dispatch-liveness-hardening (now expects a throw), createDispatchSinks default-provider expectations in `we:scripts/operations/__tests__/dispatch-lane.test.mjs` and `we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs` (both also conflict in the real merge), and runner-activity-io tests if they assume the checkout-local runs dir.
10. Run dispatch-lane*, wake, explore, effect-executor, run-store, runner-activity tests, then `npm run check:standards`.

### Designer rulings (2026-09-22)

- **Order fixed:** this slice now lands before #3903 (no longer blocked by it) and owns `we:scripts/operations/delivery-agent-marker.mjs`, `we:scripts/operations/wake.mjs` and `we:scripts/operations/explore-io.mjs`.
- Session-id: take the branch's throw in `defaultClaudeProvider`; keep main's argv without `--session-id` (main's tests enforce it; no behaviour effect).
- `we:scripts/operations/runner-activity-io.mjs` (main-only) changes ONLY to follow the run-store root move (`resolveRunsDir()`), so main's activity report keeps seeing dispatches.

### Addendum: snapshot moved to 600acc14f (2026-09-23)

Re-ran the trial merges at the new prototype tip (base `ca7e68b71` for both files, per the existing note).
`we:` prefixes below are repo-relative paths.

**`we:scripts/operations/dispatch-lane-io.mjs`** — **10 conflicts**, up from the note's 7 (real merge-tree) /
6 (single-base). One old conflict is GONE (the `findItem` `...size` spread at old ~L859 now merges clean —
main has independently converged on the same shape), but a bigger, genuinely NEW source of conflict appeared:
main has grown its OWN unrelated feature, **`we:3979` (a `gh`-App-token `--settings` env shim)**, touching
the exact same functions the branch's **#3857 model-tier table** touches:
- `createDispatchSinks(...)` gained a `resolveSettingsEnv = resolveGhShimSettingsEnv` parameter (main) that
  now sits where the branch adds `freshenCheckout = () => {}` — keep BOTH params.
- Inside the dispatch effect, main's plain `provider({...settingsEnv: resolveSettingsEnv()})` call must be
  merged into the branch's `guardedDispatch(...)`-wrapped call, keeping `settingsEnv` (main) AND `table`/
  `modelReason` (branch, #3857) in the same `provider()` call.
- `defaultClaudeProvider`'s `buildAgentArgv(...)` call must pass BOTH `settingsEnv: request.settingsEnv ?? null`
  (main) and `table`/`modelReason` (branch).
- `buildAgentArgv`'s own signature must become a UNION: `{ sessionId, payload, extraArgs=[], systemPromptFile=null,
  resumeSessionId=null, settingsEnv=null, table=null, modelReason=null }` — main and branch each independently
  turned this into a multi-line destructure with a new trailing param, so this is a real merge, not a
  take-one-side resolution. The return array itself (the `--settings`/`modelArgs` spreads) auto-merged clean in
  the trial — only the signature/JSDoc/body-comment region needs hand merging.
- The three OLD docblock conflicts (`THE HANDLE …`, `PROVEN AGAINST …`, the provider-port paragraph) are
  unchanged in nature/resolution, just shifted ~90 lines down.
- **Worker step 5 in the existing note ("branch throw + `WE_DISPATCH_KIND`... make docblocks agree") is now
  INCOMPLETE** — it must also fold in the `3979` settingsEnv threading through the same three call sites,
  which the old note never saw because main added it after 2026-09-22.

**`we:scripts/operations/dispatch-lane.mjs`** — **6 conflicts**, up from 5[4]. The two old-ruling conflicts
(`sessionSlugFor` → keep main's `mintSessionSlug`; not-cleared `holdReason` → keep main's `raw.admission?.held`)
and the `LAUNCH_KINDS`-block conflict are unchanged in nature. Two are now bigger UNIONS because main did its
own **#3960 (multi-repo slice 4)** work on the same constants since the old snapshot:
- `BRIEF_PLACEHOLDERS`: union main's 5 new repo-aware tokens (`REPO`, `LANE_REPO`, `GATE_COMMAND`, `WE_ROOT`,
  `ATTRIBUTION`) with branch's 2 (`ATTRIBUTION_KIND`, `ATTRIBUTION_NUM`) — not just "add branch's tokens" as
  the old note said.
- `BRIEF_REQUIRED_BY_KIND`: `fix` needs BOTH main's 5 repo-aware tokens AND branch's 2 attribution tokens;
  `ci-heal` needs only main's 5 (branch never touched `ci-heal`'s list).
- **New conflict**: the `fillBrief(...)` call itself — main added a 5th argument
  (`repairsExistingPr ? REPO_AWARE_VALUE_PATTERNS : undefined`, #3960) at the exact call site the branch's
  #3717 taskType/routing/supervision-gate block (a ~90-line addition) is inserted right after. Keep main's
  5-arg `fillBrief` call, then the branch's block unchanged.

**`we:scripts/operations/__tests__/dispatch-lane.test.mjs`** — **2 conflicts** (not previously counted). One is
a trivial `vitest` import (`vi` unused on branch — drop it, keep branch's clean import). The other is the
`expectedPrompt('fix', {...})` fixture in the fix-dispatch test: must union main's `WE_TOKENS('2608')` spread
(the #3960 five) with branch's `ATTRIBUTION_KIND: 'WE', ATTRIBUTION_NUM: '2608'` literals — confirms the same
union both `we:scripts/operations/dispatch-lane.mjs` conflicts above need.

**New add-only files in this card's scope, unaffected (still missing on main, 0-conflict copies from `600acc14f`):**
- `we:scripts/operations/dispatch-task.mjs` — gained a `modelReason` input + read (#3857), forwarded to the spawn.
- `we:scripts/operations/dispatch-task-io.mjs` — gained `readItemRoutingFacts(item, io)` (best-effort `scope:`/
  `tags:` lookup for a `--item`-carrying brief, via `we:scripts/operations/resolve-io.mjs#resolveBacklogFile`/
  `readScopeList`, already on main) and now imports `workerTierFor` (`we:scripts/lib/provider-routing.mjs`) and
  `resolveWorkerModel` (`we:scripts/operations/dispatch-lane-io.mjs`). No new npm dependency (`gray-matter` is already used
  elsewhere on main, e.g. `we:scripts/backlog.mjs`).
- `we:scripts/operations/__tests__/dispatch-task.test.mjs`, `we:scripts/lib/__tests__/dispatch-supervisor.test.mjs`,
  `we:scripts/operations/__tests__/dispatch-lane-routing-record.test.mjs` — still missing on main, straight adds.

**Worker steps (revise)**
5'. When hand-merging `we:scripts/operations/dispatch-lane-io.mjs`, ALSO fold in the `3979` `settingsEnv`
    threading (see above) into `createDispatchSinks`, `defaultClaudeProvider`, and `buildAgentArgv`'s signature —
    not just the throw/`WE_DISPATCH_KIND`/argv resolution the original step 5 named.
4'. When hand-merging `we:scripts/operations/dispatch-lane.mjs`, union `BRIEF_PLACEHOLDERS`/
    `BRIEF_REQUIRED_BY_KIND.fix` (main's 5 `#3960` tokens + branch's 2 `ATTRIBUTION_*` tokens) and keep main's
    now-5-argument `fillBrief(...)` call ahead of the branch's `#3717` routing block.
9'. Port `we:scripts/operations/__tests__/dispatch-lane.test.mjs`'s branch diff too (2 conflicts, above) —
    not previously listed as needing a diff-port.

## Graduation import check

- 2026-09-24: graduation-import-check moved `we:scripts/operations/__tests__/dispatch-lane-prepare-decision-wiring.test.mjs` to #3905 — it imports a module #3905 owns.
- 2026-09-24: graduation-import-check moved `we:scripts/operations/__tests__/dispatch-lane-fix-wiring.test.mjs` to #3904 — it imports a module #3904 owns.
- 2026-09-24: graduation-import-check moved `we:scripts/operations/__tests__/dispatch-lane-ci-heal-wiring.test.mjs` to #3904 — it imports a module #3904 owns.
- 2026-09-24: graduation-import-check moved `we:scripts/operations/__tests__/dispatch-lane-build-wiring.test.mjs` to #3903 — it imports a module #3903 owns.
- 2026-09-24: graduation-import-check moved `we:scripts/operations/__tests__/dispatch-kind-axes.test.mjs` to #3904 — it imports a module #3904 owns.
