---
bornAs: x4rkpuk
kind: story
size: 5
parent: "3443"
status: open
blockedBy: ["3902", "3893", "3906", "3917"]
scope: ["we:scripts/operations/__tests__/completion-cli.test.mjs", "we:scripts/operations/__tests__/completion-record.test.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs", "we:scripts/operations/completion-cli.mjs", "we:scripts/operations/completion-record.mjs", "we:scripts/operations/deliver-item-run.mjs", "we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/operations/delivery-report-store.mjs", "we:skills-src/conveyor/delivery-agent-brief-v2.md", "we:skills-src/conveyor/delivery-agent-brief.md", "we:scripts/operations/open-pr.mjs", "we:scripts/operations/__tests__/open-pr.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-build-wiring.test.mjs"]
dateOpened: "2026-09-22"
tags: []
---

# Graduate deliver-item wrapper changes, deliver-item-run and delivery-agent-marker from lane/mechanical-dispatcher to main

Ports 8 files (we:scripts/operations/deliver-item-wrapper.mjs, we:scripts/operations/deliver-item-run.mjs, we:scripts/operations/delivery-agent-marker.mjs, we:scripts/operations/delivery-report-store.mjs, we:scripts/operations/completion-record.mjs, we:scripts/operations/completion-cli.mjs, we:skills-src/conveyor/delivery-agent-brief.md, we:skills-src/conveyor/delivery-agent-brief-v2.md) plus their tests. On the critical path. we:scripts/operations/deliver-item-wrapper.mjs is a 1.6k-line diff that main also changed. Main also changed these files, so each gets a diff-merge: we:scripts/operations/deliver-item-wrapper.mjs. Graduation slice of epic #3443 (see its Slice procedure). FAITHFUL PORT: no behaviour change while porting; the branch code lands as-is (operator, 2026-09-22). Port from snapshot 600acc14f of origin/lane/mechanical-dispatcher. For every file main has changed since the merge base ca7e68b71 (check with git log ca7e68b71..origin/main -- <file>), apply the branch diff onto main's current file; never copy the branch file over it. Add only this slice's own lines to we:scripts/operations/run.mjs and the we:scripts/operations/__tests__/http-adapter.test.mjs pin (append-only, so parallel slices merge cleanly). Full gate on main's tree: check:standards, test, smoke. Hold lifted 2026-09-24: the #3857 model-tier table passed a live probe and the operator started wave A.

## Done when

1. **Executable** — `npx vitest run we:scripts/operations/__tests__/completion-cli.test.mjs we:scripts/operations/__tests__/completion-record.test.mjs we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs we:scripts/operations/__tests__/open-pr.test.mjs` passes on main's tree (all of this slice's tests; each fails before the port because its module is missing or differs).
2. **Executable** — `npm run check:standards` reports 0 errors, and the PR's required `test` and `smoke` checks are green.
3. **Faithful port** — for each ported file, `git diff 600acc14f -- <file>` (prototype snapshot vs main after the port) shows only main's own later changes kept by the merge notes, never a behaviour change of the branch code; runtime data files (e.g. `we:scripts/conveyor/run-scorecards.json`) are never edited.

### Merge notes for #3903 (2026-09-22)

**Base caveat (read first).** History is criss-crossed: `git merge-base --all origin/main ff1618065` returns `ca7e68b71` **and** `21aaedb0b` (a parentless root commit both sides contain, carrying the 1494-line #3627 wrapper). For `we:scripts/operations/deliver-item-wrapper.mjs` and its test, use **`21aaedb0b` as base**. `ca7e68b71` as base shows a bogus ~1.6k-line diff and 37 conflicts; plain `git merge`/`merge-tree` (virtual base) shows 13. Real branch delta vs `21aaedb0b` is +689/−316.

**`we:scripts/operations/deliver-item-wrapper.mjs`**
- Main: only `fd37ce270` (#3627 review) — `git add -- <paths>` before `git commit` in `commitConvergeRound`, plus one docblock sentence.
- Branch (22 commits): extracts shared primitives to `we:scripts/operations/minimal-context-provider.mjs` (re-exported: `acquireLane`, `resetStaleVerifyMarker`, `resolveLanePath`, `runVerifyOperation`, `buildRestrictedProviderArgv`); telemetry spans/recorder; `CODEX_PROVIDER` + provider registry (`DELIVERY_AGENT_PROVIDER_NAMES`, `DEFAULT_DELIVERY_AGENT_PROVIDER_NAME`, `resolveDeliveryAgentProvider`); wrapper-owned commit (`commitBuildTurn`, `coAuthorTrailerFor`, `sanitizeOwnLocusMentions`, `prefixOwnPathMentions`); async spawn via `spawnAgentToCompletion`, `runGateWithOneRetry` now **async**; `claimItem` takes `lanePath`; PR number via `extractSubmitResult`; per-lane reports dir; run-quality scorecard recording; routing record's `executed` = real vendor.
- Trial merge (`git merge-file -p main base2 branch`, base2 = `21aaedb0b`): **1 conflict**, `commitConvergeRound` → `commitBuildTurn` boundary: both sides added the same `runFn('git', ['add', '--', ...paths])` line. **Take branch side.** The docblock auto-merges with both "stage first" notes; optionally drop main's added sentence as redundant.
- Test `we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs` (same base): **3 conflicts**, all the same theme: ~L691 fake-run `git add` stub (take branch); ~L1260 `commitConvergeRound` test title (either); ~L1280 assertions (keep main's `calls[0]` no-`-A` checks **and** branch's new "stages a NEW untracked file" test).
- Dependencies (branch-only, absent on main): `we:scripts/operations/telemetry-store.mjs` (→ `we:scripts/operations/telemetry.mjs`), `we:scripts/operations/session-role.mjs`, `we:scripts/operations/minimal-context-provider.mjs`, `we:scripts/operations/codex-delivery-provider.mjs` (→ `we:scripts/lib/codex-model-routing.mjs`, `we:scripts/lib/usage-report-secret-paths.mjs`, `we:scripts/lib/spawn-to-completion.mjs`), `we:scripts/conveyor/run-quality-record.mjs` (→ `we:scripts/lib/model-probation.mjs`, `we:scripts/conveyor/run-quality-scorer.mjs`, `we:scripts/conveyor/run-quality-subject-class.mjs`). Symbols missing on main: `extractSubmitResult` in `we:scripts/operations/open-pr.mjs` (this card), `findUnmarkedLocusRefs` in `we:scripts/check-standards-rules.mjs`, `spawnAgentToCompletion` in `we:scripts/operations/dispatch-lane-io.mjs` (**#3906**). Already on main: `fillBrief`, `we:scripts/lib/review-escalation.mjs`, `we:scripts/lib/gate-config.mjs`, `we:scripts/lib/lane-litter.mjs`, `we:scripts/lib/isolation-provider.mjs`, `we:scripts/lib/lane-pool-paths.mjs`, `we:scripts/conveyor/run-scorecard-store.mjs`. Main renamed/removed nothing the branch uses.
- Semantic risks: `runGateWithOneRetry` sync→async has no main-side callers outside this file; `claimItem` signature is internal-only; `resolveDeliveryReportsDir(lane)` requires the delivery-report-store change below in the same PR. `we:scripts/guard-bash.mjs` and `we:scripts/operations/delivery-report-record.mjs` only mention the wrapper in comments — nothing on main imports it.
- Separable? **No — land whole.** Extraction, provider port, telemetry, wrapper-owned commit and async spawn all thread through `deliverItem`/provider objects; slicing would mean inventing intermediate states.
- Cycle with #3904? **None.** `we:scripts/operations/fix-dispatch-wrapper.mjs` and `we:scripts/operations/ci-heal-dispatch-wrapper.mjs` import from the wrapper (`runConverge`, `DELIVERY_AGENT_SPAWN_TIMEOUT_MS`, `DELIVERY_AGENT_PROVIDER_NAMES`, `DEFAULT_DELIVERY_AGENT_PROVIDER_NAME`); the wrapper imports neither; `we:scripts/operations/dispatch-providers/build.mjs` spawns it as a process and does not import it. Order is one-way: **#3906 → #3903 → #3904**.

**`we:scripts/operations/open-pr.mjs`**
- Main: `f48582572` (#3690 session-delegation trial auto-log). Branch: `11a5b78af` adds `extractSubmitResult` (openPr callers read the real PR number, not the envelope's top level).
- Trial merge (base `ca7e68b71`): **0 conflicts**. Take the merged result.

**Small files**
- `we:scripts/operations/delivery-report-store.mjs`: main untouched; branch adds optional `root` arg to `resolveDeliveryReportsDir`. Clean apply.
- `we:scripts/operations/completion-record.mjs`: main untouched; branch `COMPLETION_KINDS` = review, fix, ci-heal, task. Clean apply.
- `we:scripts/operations/completion-cli.mjs`: main (`f211888d0`) `mintSessionSlug` + `repo`/`repoKeyForSlug`; branch `COMPLETION_KINDS` guard, ci-heal in usage strings, blank `--item=` → null. **3 conflicts**: `sessionSlugForCompletion` (keep main's `repo='we'` param and `mintSessionSlug` return, use branch's `COMPLETION_KINDS` guard/docblock); `runReport` (branch's blank-item line and usage text + main's `repo: flags.repo`); `runShow` (same). Risk: `task` is not in main's `PR_KINDS`, so `--kind=task --pr=N` without `--session` throws in `mintSessionSlug` — acceptable, task reports always pass `--session`.
- `we:skills-src/conveyor/delivery-agent-brief.md`: main (`aa5ad053d`) moves resolve to step 8; branch adds only the "fallback path" header. **0 conflicts**, coherent (`WE_BUILD_DISPATCH_MODE` still exists on the branch as `BUILD_DISPATCH_MODE_ENV`).

**Worker steps**
1. Confirm #3906 has landed (at minimum `spawnAgentToCompletion` in `we:scripts/operations/dispatch-lane-io.mjs`, `we:scripts/lib/spawn-to-completion.mjs`, `we:scripts/operations/session-role.mjs`).
2. Land the branch-only helper modules listed under Dependencies (check card ownership first) and the `findUnmarkedLocusRefs` export in `we:scripts/check-standards-rules.mjs` if no other card carries it.
3. `git merge-file` `we:scripts/operations/open-pr.mjs` (base `ca7e68b71`, 0 conflicts).
4. `git merge-file` the wrapper and its test with base = `git show 21aaedb0b:<file>`; resolve 1 + 3 conflicts as above.
5. Apply the delivery-report-store and completion-record branch diffs; hand-merge completion-cli (3 conflicts).
6. Take the merged `we:skills-src/conveyor/delivery-agent-brief.md` as-is.
7. Run the wrapper, open-pr, completion-cli and delivery-report tests plus main's `we:scripts/operations/__tests__/commit-converge-round-real-git.test.mjs`.

### Designer rulings (2026-09-22)

- **Order fixed:** the wrapper needs `spawnAgentToCompletion` from #3906's `we:scripts/operations/dispatch-lane-io.mjs`, so this slice now lands after #3906 (not before). `we:scripts/operations/delivery-agent-marker.mjs` moved to #3906 to break the cycle.
- Also owns `we:scripts/operations/open-pr.mjs` (the wrapper needs `extractSubmitResult`) and waits on 3917 for `findUnmarkedLocusRefs` in `we:scripts/check-standards-rules.mjs`.

## Graduation import check

- 2026-09-24: graduation-import-check moved `we:scripts/operations/__tests__/dispatch-lane-build-wiring.test.mjs` here from #3906 — it imports a module this card owns.
