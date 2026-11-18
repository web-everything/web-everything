---
bornAs: xvprtq3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "0a352384aeb4e89efbe57fbf54c2c7230bab7e00"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2969's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs` — Add deterministic CLI coverage with fresh positive and negative cached verdicts: bypass ignores both, refreshes at most two pending IDs per tick, rotates through the stale population, preserves the seeded verdict store during bypass, and replays it on a later ordinary tick. Separately prove ordinary refresh persists successful fresh results while preserving unrelated cache entries. See the premise correction below.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2969@8463550d6c465421ffda6fc27904cd2ee6d97f9c

## Progress

- **Old premise/scope:** the prior preparation specified write-through bypass refreshes and subsequent replay of reversed verdicts, in one integration test file. Its earlier all-ID inline premise was already obsolete.
- **Corrected premise/scope:** commit `a3654f7046` (PR #3215) made bypass read-only for verdict storage. The current caller passes `readOnly: Boolean(flags['no-already-done-cache'])` at `we:scripts/readiness/dispatch-plan.mjs:1052`; the worker suppresses writes at `we:scripts/readiness/already-done-refresh.mjs:106`. Preserve the original seeded-cache prevention goal, but assert unchanged verdict storage during bypass. Exercise persistence separately through ordinary refresh with expired seeds. Scope remains solely `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs`.
- **Current source evidence:** cache reads are bypassed at `we:scripts/readiness/dispatch-plan.mjs:1039`. Selection is capped at two and ordered by last attempt at `we:scripts/readiness/already-done-refresh.mjs:11` and `we:scripts/readiness/already-done-refresh.mjs:16`; attempts are recorded even in read-only mode at `we:scripts/readiness/already-done-refresh.mjs:104`. Unknown shallow history returns no verdict at `we:scripts/readiness/already-done-refresh.mjs:51`. Successful ordinary writes merge entries through `we:scripts/readiness/already-done-cache.mjs:62`.
- **Remaining gap:** `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs:142` combines an empty cache with zero negative cooldown. The read-only bypass test at `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs:154` also starts empty. Positive replay now starts at `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs:171`. None combines fresh positive and negative seeds, both queue populations, contradictory remote results, rotation, and preservation. This goal is not already delivered.
- **Estimate:** retain story size 3 (old 3 → new 3). One file, approximately 120–170 changed lines for fixture parameters, seed/assertion helpers and two integration scenarios, grounded in the fixture at `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs:50`, CLI wrapper at `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs:106`, and existing refresh tests. No production touch set or dependency change is needed.
- **Verification provenance:** the earlier preparation recorded six passing tests. That is historical evidence, not a current run; the current file has eight generated cases. This preparation inspects source and authors the card only; execution and mutation proof below belong to implementation. Existing preparation stamps are left for the runner.

## Design

Extend only `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs`. Parameterize `buildFixture` with ready and not-ready counts, preserving its defaults of 60 and 10 and the existing callers. Use two ready IDs (8000, 8001) and two blocked IDs (8100, 8101), shallow history, the real CLI, isolated fake host/throttle state, and the existing bounded lock-settlement helper. Keep scratch fixtures under the task's `TMPDIR`.

Seed fresh positives for 8000 and 8100 and fresh negatives for 8001 and 8101, plus an unrelated sentinel. Pin the production cooldown values explicitly through both environment overrides: positive 86400000 ms and negative 1800000 ms, as defined at `we:scripts/readiness/already-done-cache.mjs:16`. Validate freshness with `getCachedVerdict` before the first invocation. Return merged implementation PRs for 8001 and 8101 and no matching PRs for 8000 and 8100. Provide numeric titles, URLs, implementation branch names and non-documentation file metadata accepted by `filterAlreadyDoneCandidates` at `we:scripts/operations/dispatch-lane-io.mjs:3260`.

Run two settled bypass ticks. Each must report zero cached verdicts, four pending IDs, no already-done holds, and exactly two selected/search IDs. The pairs must be disjoint and together equal the four fixture IDs. Inspect actual GraphQL search arguments, not only call counts. Compare the entire verdict file byte-for-byte with the seed after each settled tick. Attempts and diagnostic sidecars may change. An ordinary third tick must replay the original positives for both populations, consume all four cached verdicts, and issue no searches: bypass results were deliberately not persisted.

Use a separate ordinary-refresh scenario with the same contradictory results but expired seeds. Two settled ordinary ticks refresh all four IDs; selected entries reverse signs, unselected entries and the sentinel remain deeply equal, and fresh results replay on the third tick without more searches. Results belong to subsequent plans, never the initiating plan. Absence of an already-done hold does not promise dispatch eligibility.

No production defaults, interfaces or fail-closed policy change. Retain the existing unavailable-cache test: it reports an error and pending checks without inline network IO. Incomplete local evidence remains unknown; this story must not invent a dispatch-blocking policy.

## MVP

1. Add the fresh mixed-seed bypass regression across both queue populations with nonzero cooldowns, exact bounded rotation, unchanged verdict bytes and ordinary replay of original seeds.
2. Add the expired mixed-seed ordinary-refresh regression covering successful replacement, unrelated/unselected preservation and later replay.
3. Preserve fixture defaults and all eight existing cases. Await refresh settlement before inspections and cleanup, including assertion-failure cleanup; nest cleanup in `finally` so host/fixture cleanup still occurs if settlement throws.

## Acceptance

For every executable line below, the named test lives in `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs`. Define command T as the host-queued targeted Vitest run: invoke `node` on `we:scripts/readiness/heavy-admission.mjs` with `run --wait-ms=60000 -- npx vitest run` and that test file. Repository markers identify paths; strip `we:` when supplying shell arguments. If admission stays busy after this one wait, stop and report it.

The executable acceptance probe first requires the named new test to exist (`rg -q -F` with its exact name and the scoped file), then runs T. This presence check fails before the guard is built and the combined probe must pass afterward. Production behavior already exists; no claim is made that unchanged production should fail the new tests. Mutation proof below establishes regression sensitivity.

- [A1] Executable: presence probe for `fresh mixed seeds bypass reads and preserve verdict bytes across bounded rotation`, then T. Assert freshness, zero cached/four pending, no seeded-positive holds, two searches per settled tick, exact disjoint ID sets, and unchanged complete verdict bytes including sentinel. Shallow history must stay unknown rather than being fabricated into a local negative.
- [A2] Executable: the A1 presence probe, then T. In that named test assert a subsequent ordinary tick caches all four original seeds, holds the original positive IDs in both populations, excludes negative IDs from already-done holds, and adds zero searches.
- [A3] Executable: presence probe for `ordinary mixed seeds refresh persists replacements and preserves unrelated entries`, then T. Assert expired seeds are refreshed two at a time, successful results reverse both signs, untouched entries remain equal, and later ordinary replay uses all four fresh results with no additional searches.
- [A4] Executable: both new-test presence probes, then T over the entire scoped file. Retain the eight existing cases, including `unwritable cache exposes pending checks without crashing or doing inline network IO` and `--no-ground-truth makes zero gh spawns and starts no refresh`. Existing callers retain 60/10 defaults and the 70-pending assertion. New cases use isolated state and settle workers before cleanup.

## Test plan

Implement the named cases and local helpers in the scoped test file. Run only command T through the host heavy queue. Compare per-tick queried IDs with reported refresh IDs, and compare final ID sets exactly. Read cache state only after worker settlement. Validate PR identity as well as verdict signs and timestamps; compare parsed entries for legitimate ordinary writes, byte equality for bypass. Keep existing large-queue and zero-cooldown coverage intact. Use no external GitHub or shared conveyor state.

For the ordinary scenario, make seed ages exceed the respective production cooldowns explicitly. Keep the sentinel outside the queue and unchanged throughout. Verify the first plan has pending evidence and the final plan replays all refreshed entries, without assuming asynchronous work completed before CLI output.

## Proof plan

During implementation, capture the acceptance presence checks failing before adding the new tests and passing afterward with command T. Then use temporary, separately restored mutations to prove assertions detect regressions:

1. Remove bypass cache-read suppression at `we:scripts/readiness/dispatch-plan.mjs:1039`: A1 must fail on cache counts, pending IDs or positive holds.
2. Force `readOnly: false` at `we:scripts/readiness/dispatch-plan.mjs:1052`: A1 must fail on verdict bytes and A2 on original-seed replay.
3. Change the selection ceiling at `we:scripts/readiness/already-done-refresh.mjs:11` to three, then separately ignore attempts in selection at `we:scripts/readiness/already-done-refresh.mjs:16`: A1 must reject the oversized pair and repeated IDs respectively.
4. Suppress successful writes at `we:scripts/readiness/already-done-refresh.mjs:106`: A3 must fail on replacement/replay. Separately replace the merge input with an empty cache: A3 must fail on sentinel/unselected preservation.

Run the affected named test through command T with Vitest's test-name filter for each mutation; restore before the next mutation. Record exact failed assertions and the final restored full-file result. Mutations are implementation-time proof only, never part of the delivered diff or this preparation. Use the host queue for every run and respect its single-wait rule. Runner-owned checks and independent review remain separate.

## Follow-ups

None required. Reintroducing write-through bypass or all-ID inline queries would change shipped behavior and is outside this test-only guard. If implementation finds a production defect, report the failed invariant and revise the touch set with matching source/test coverage before expanding the implementation. No blockedBy changes are proposed.
