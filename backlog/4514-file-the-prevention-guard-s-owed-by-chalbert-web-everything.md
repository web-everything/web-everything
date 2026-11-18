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

1. `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs` — Add deterministic CLI coverage with fresh positive and negative cached verdicts: bypass ignores both, refreshes at most two pending IDs per tick, rotates through the stale population, leaves the verdict store unchanged during bypass, and persists/replays successful results on ordinary ticks. Preserve unrelated cache entries. See the premise correction below.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2969@8463550d6c465421ffda6fc27904cd2ee6d97f9c

## Progress

- **Old premise/scope:** the previous preparation proposed bypass-worker writes and later replay of those writes, with a single test-file scope. Earlier inline/all-ID enrichment assumptions had already been superseded by bounded background enrichment. Its six-test baseline is historical, not a current verification result.
- **Corrected premise/scope:** commit `a3654f70469cc6deb31ff36ffedeb467bdf23862` (PR #3215) made bypass read-only for the verdict store. Preserve the original seeded-cache prevention goal by testing bypass read suppression, bounded rotation and unchanged verdict bytes, then ordinary refresh persistence/replay separately. Scope remains solely `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs`; no production behavior change is needed.
- **Source evidence:** `we:scripts/readiness/dispatch-plan.mjs:1039` suppresses cached reads; `we:scripts/readiness/dispatch-plan.mjs:1052` passes `readOnly` to the worker. `we:scripts/readiness/already-done-refresh.mjs:85` transports it, and `we:scripts/readiness/already-done-refresh.mjs:106` writes only checked, non-read-only verdicts. Attempts still persist independently at `we:scripts/readiness/already-done-refresh.mjs:104`; rotation uses those attempts at `we:scripts/readiness/already-done-refresh.mjs:17`. Thus “unchanged store” means verdict file, not every sidecar.
- **Remaining gap:** `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs:142` uses an empty cache and zero negative cooldown. Its read-only guard at line 154 also starts empty. Positive replay now starts at line 170, not the previously cited line 154; line 163 starts the no-ground-truth test. None exercises contradictory fresh positive AND negative seeds across both populations. The goal is not already delivered.
- **Sizing:** retain size 3 (old 3 → new 3): one test file, approximately 15–25 changed helper lines around `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs:49` and 100–140 new scenario/assertion lines alongside its existing cases at line 142. This includes ordinary refresh and failed-lookup cases. This is a story; no `estimatedLoc` is added.
- **Preparation verification:** inspected current source and delivering commit history. No runtime baseline is claimed for this pass. Runner owns stamping/checks; existing preparation stamps are preserved.

## Design

Extend the fixture in `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs` with optional ready/not-ready counts, retaining defaults 60/10 for every existing caller. New cases use ready IDs 8000/8001 and blocked IDs 8100/8101 with shallow history so local negative evidence cannot short-circuit enrichment. Keep the real CLI, fake host, isolated throttle/cache state and lock-settlement helper. Set both cooldown environment overrides explicitly to the existing defaults (negative 1800000 ms; positive 86400000 ms).

Seed fresh positives for 8000/8100, fresh negatives for 8001/8101 and an unrelated sentinel. Confirm freshness using `getCachedVerdict` from `we:scripts/readiness/already-done-cache.mjs:57`. Return contradictory valid merged PRs for 8001/8101 and no matches for the former positives. Supply numeric item titles, merged timestamps, implementation branch names, URLs, body and non-documentation changed files accepted by `we:scripts/operations/dispatch-lane-io.mjs:3260`.

Run two settled bypass ticks. Each initiating plan must have zero cached verdicts, four pending IDs and no seeded already-done holds. Each refresh selects two IDs; actual GraphQL searches must match those IDs, with disjoint pairs covering all four exactly once. After each settlement the verdict file must remain byte-identical, including the sentinel; attempt sidecars may change. An ordinary tick immediately afterward must replay the ORIGINAL four fresh seeds, hold 8000/8100 in both populations and make no searches. This proves bypass results cannot leak into persisted replay.

In a separate ordinary-refresh case, age the four fixture seeds beyond both cooldowns while keeping the sentinel unchanged. Two settled ordinary ticks must persist contradictory successful results for their selected pairs, preserve unselected entries and the sentinel, and a third tick must replay all four refreshed verdicts without another search. Positive holds now belong to 8001/8101. Assert absence only of already-done holds for negatives; other readiness holds remain legitimate.

Add a failed-lookup case with stale seeds: a fake-host malformed response must leave their signs and timestamps unchanged, record attempts, settle the worker and leave unknown IDs pending on the next tick. No failure is converted into a successful negative cache entry. This is the existing unknown-evidence path, not a new dispatch policy or a claim that pending rows are globally blocked.

## MVP

1. Parameterize fixture counts without changing defaults or existing callers; pin normal cooldowns and validate seed freshness.
2. Cover fresh seeded bypass, bounded rotation, unchanged verdict bytes and subsequent original-seed replay for both populations.
3. Cover ordinary refresh persistence, untouched entries and later reversed-verdict replay.
4. Cover failed lookup without a false negative write. Settle detached workers before assertions and cleanup, including assertion-failure cleanup; retain all existing cases.

## Acceptance

Each named test below is proposed in `we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs`. For each [A<n>], the executable check consists of a required-name preflight (`rg -q -F` for its exact title in that file, failing when absent), followed by the targeted heavy-queue suite command in Test plan. The preflight fails before the build because these named guards are missing; after the build both preflight and suite must pass. This is coverage-debt red-to-green, not a claim that current production behavior fails.

- [A1] Executable: test `seeded bypass ignores both signs and rotates without verdict writes` — assert fresh mixed seeds, both populations, zero cache hits/four pending per bypass tick, no seeded holds, exact two-search pairs and four-ID union, byte-identical verdict file and sentinel after settlement, and ordinary replay of the original seeds without more searches.
- [A2] Executable: test `ordinary refresh persists reversed verdicts and replays both populations` — assert expired mixed seeds, selected writes with fresh timestamps/PR identities, unchanged unselected and unrelated entries, two-search ceiling, complete rotation and final replay with no searches.
- [A3] Executable: test `failed refresh preserves stale verdicts and pending evidence` — assert malformed host output never advances verdict timestamps or fabricates negative evidence, attempts rotate, worker settles and subsequent plans still report pending IDs.
- [A4] Executable: test `fixture defaults retain the existing queue populations` — directly assert default fixture produces 60 ready and 10 blocked cards and the explicit small fixture produces 2/2; run all existing cases with their unchanged callers through the same suite command. Production defaults and interfaces remain unchanged.

## Test plan

Run only the scoped suite through `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npx vitest run we:scripts/readiness/__tests__/dispatch-plan-already-done-bounded-spawn.test.mjs`. Repository prefixes identify paths in this card; strip `we:` from command path arguments when executing from the WE checkout. Use the queue's single bounded wait; if it remains busy, stop and report rather than polling.

Parse actual fake-host GraphQL search arguments and compare exact queried-ID sets against each plan's refresh IDs. Inspect files only after `waitRefresh`; use byte comparison for bypass and deep per-entry comparison for legitimate ordinary writes. Assert normal cooldown freshness rather than relying on inherited environment or sleeps. Isolate temporary fixtures under the task temporary directory, with no external GitHub or real conveyor state. The fake host may gain a local malformed-output option; its default response remains unchanged. Cleanup must settle refresh before removing host or fixture files.

## Proof plan

Capture each acceptance preflight failing on the pre-build test file, then all four preflights and the scoped suite passing after implementation. Missing-test preflight alone is insufficient final evidence: retain the actual CLI assertions and their passing test output.

In a disposable implementation proof checkout, independently mutate and restore: cache-read suppression at `we:scripts/readiness/dispatch-plan.mjs:1039` (A1 fails on cached/pending counts); read-only transport at `we:scripts/readiness/dispatch-plan.mjs:1052` (A1 fails on verdict bytes); selection ceiling or attempt ordering at `we:scripts/readiness/already-done-refresh.mjs:17` (A1/A2 fail on pair bounds or coverage); successful write at `we:scripts/readiness/already-done-refresh.mjs:106` (A2 fails on persisted signs/replay); and failed-response handling at `we:scripts/readiness/already-done-refresh.mjs:129` (A3 fails if malformed output is treated as a checked negative). Run the same queued targeted suite for each mutation and restore immediately. These source paths are proof-only, excluded from the delivered touch set.

Record failing assertions and a final restored passing suite. Do not claim an unchanged production baseline must fail the new guards: the missing artifact is regression coverage. Preparation itself changes only this card; runner stamping and independent review remain separate.

## Follow-ups

None required. Restoring bypass-worker verdict writes or inline all-ID enrichment would change shipped behavior and is outside this prevention story. If implementation exposes a production defect, report the failed invariant and propose a source/test scope correction before changing behavior. No blockedBy change is proposed.
