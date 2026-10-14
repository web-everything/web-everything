---
bornAs: xsvxy4v
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/__tests__/merge-ai-prs-confirm-merged-before-landed.test.mjs", "we:scripts/__tests__/merge-ai-prs-merge-trace-post-confirm.test.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/conveyor/__tests__/helpers/fake-gh-shim.mjs", "we:scripts/conveyor/__tests__/fake-gh-state.test.mjs", "we:scripts/conveyor/soak/breaks/drain-records-enqueued-pr-as-landed.mjs", "we:scripts/conveyor/soak/breaks/drain-records-enqueued-pr-as-landed.soak.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/drain-records-enqueued-pr-as-landed.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-14"
preparedAgainstSha: "a01ad92201b64df20121a31681c47b06e91885fc"
tags: []
---

# Drain: confirm a PR is MERGED before recording it as landed

After gh pr merge returns, the drain (we:scripts/merge-ai-prs.mjs, the mergePr write site before merged.push) adds the PR to merged/landedThisPass, posts its landed trace and starts post-land work without checking GitHub actually merged it. Once main has a merge-queue ruleset, a drain-direct pass (a stale drain clone, a lane's /pr or /finish run that reads its own branch's we:scripts/settings/merge-queue.json, a pr-watch fast drain, a manual /drain) gets gh pr merge turned into an enqueue, and the PR is recorded as landed early even if merge-group CI then fails. Fix: require a fresh, explicitly repo-scoped MERGED response after mergePr; otherwise report an unconfirmed write, never landed, and retain durable follow-up tracking. Found in the PR #4950 fix round (merge-queue switch runbook); that runbook lists this card as a precondition for the switch. Add a soak break for the live case.

## Done when

- [A1] **Executable** — a test in `we:scripts/__tests__/` drives the drain's merge write site with a `gh pr merge` stub that exits 0 while the PR stays OPEN (enqueued): before the fix the PR lands in `merged`/`landedThisPass`; after, it does not, and no landed trace or post-land work runs.
- [A2] A soak break in `we:scripts/conveyor/soak/breaks/` reproduces the live case (drain-direct pass against a queued main) RED before, GREEN after.
- [A3] A PR that really merged (re-probe says MERGED) is still recorded as landed exactly as today.

This tightens confirmation for source, docs, config and data PRs equally. No receive endpoint is added; body-size caps, CSRF/origin checks and inbound rate limits are not applicable.

## Non-goals

- [N1] Does not change the `github-merge-queue` strategy path (it already treats an enqueue as not landed), the merge-queue ruleset, or the switch runbook.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the check reads GitHub's PR `state`/`mergedAt` fields, not free text.
2. **Truncated reads** — a failed or empty re-probe counts as NOT merged (never as landed).
3. **Shared state files** — the drain's queue follow-up state (`queueStatePath` in `we:scripts/lib/drain-merge-strategy.mjs`) must not get a landed entry for an unconfirmed merge.
4. **Fail closed** — any re-probe error records the PR as unconfirmed, not landed; durable pending state allows a later pass to re-check it.
5. **Identity scoping** — the re-probe names the PR's own repo (`--repo`), never the cwd default.
6. **State over time** — GitHub may report MERGED a moment late; use one immediate confirmation read; an unconfirmed PR stays pending for the existing follow-up collector, without sleeping inside the writer lock.
7. **Who wrote it** — applies to every caller of the drain (resident daemon, lane `/pr` and `/finish`, `pr-watch` fast drain, manual `/drain`), since the check sits at the shared write site.

## Progress

- Prepare-validation repair: old scope paired the planned soak break only with its sibling soak integration test. Corrected scope also includes the planned matching unit test `we:scripts/conveyor/soak/breaks/__tests__/drain-records-enqueued-pr-as-landed.test.mjs`, as required by the runner. The reference break exposes its judge at `we:scripts/conveyor/soak/breaks/couple-split-by-unrelated-merge.mjs:154`; exercise that seam with synthetic observations in the new test. The test directory does not yet exist and is planned. This adds roughly 40 test lines to the prior five-test estimate. Scope also includes the tracked `we:scripts/__tests__/merge-ai-prs.test.mjs` required by the #4448 test-pair guard (seven scoped test files total); retain its resolution-basis and default-base regressions. Size remains 3 → 3. The direct-write premise remains observable at `we:scripts/merge-ai-prs.mjs:6550`–6551.

- Rechecked on 2026-10-14 at checkout `a01ad9220`. Old premise: a successful direct merge command is recorded as landed without confirmation. Still present: `we:scripts/merge-ai-prs.mjs:6550` calls the writer, line 6551 unconditionally returns merged, and lines 6577–6585 credit the merge, post its trace and unblock items. No delivering commit found: the #5919 history contains preparation merges, including `f72880d2b`, not this fix.
- Corrected premise: `we:scripts/merge-ai-prs.mjs:4641` accepts either MERGED or a truthy mergedAt; it is not a strict state confirmation helper. The new post-write check must explicitly require MERGED, while leaving the existing pre-write/error-recovery semantics alone. An unknown read cannot truthfully be called queued.
- Old scope used directory-wide test/soak entries and claimed a CLI harness in `we:scripts/__tests__/merge-ai-prs-ci-lifecycle-and-land-effects.test.mjs`; that file imports exported helpers (line 15). Corrected scope names each production file and its matching test, plus the planned break and sibling test. The actual subprocess harness reference is `we:scripts/__tests__/merge-ai-prs-merge-failure-isolation.test.mjs:48`.
- Old design persisted only after an unconfirmed write and promised later recovery even if persistence failed. Corrected design persists pending intent before the direct write, refusing that write when persistence cannot succeed. `we:scripts/lib/drain-merge-strategy.mjs:212` already has a locked read-modify-write seam; its collector works independently of enqueue mode. Collection must avoid double-crediting immediate confirmed merges and match by repository plus number when direct sibling PRs become pending.
- Size remains 3 (old 3 → new 3): estimated touch set is about 70 lines in `we:scripts/merge-ai-prs.mjs`, 90 in `we:scripts/lib/drain-merge-strategy.mjs`, 15 in `we:scripts/conveyor/__tests__/helpers/fake-gh-shim.mjs`, 100 in the new soak break, and roughly 250 across the five scoped test files. These are planning estimates, grounded in the direct write site above, the existing pending-state machinery, and `we:scripts/conveyor/__tests__/helpers/fake-gh-shim.mjs:353`. As a story, this card has no estimatedLoc field. Existing preparation stamps are left for the runner to replace.

## Design

1. In `we:scripts/merge-ai-prs.mjs`, add a fresh post-write read of state using the candidate's explicit repository (`c.repo || localSlug`), refusing to write if that identity cannot be resolved. Accept only parsed state MERGED; OPEN, CLOSED, empty/malformed output, contradictory mergedAt-only evidence and read errors are unconfirmed. Do not reuse a cached pre-write read. Use one read, no sleep or polling loop.
2. In `we:scripts/lib/drain-merge-strategy.mjs`, add pending-intent registration using the existing entry metadata (repo, number, head SHA, item, manifest flag, head ref, title). Register before the direct merge write, outside the already-held land callback, through the existing locked read-modify-write machinery. Deduplicate by repo plus number, preserve peer entries, and refuse the merge when the state file is unreadable, the lock is refused or the write fails. An absent file may be created. A pending intent is not evidence of enqueue or land. Retain it on command failure or unknown outcome: subsequent confirmed MERGED/CLOSED determines recovery or retirement.
3. At the direct write site in `we:scripts/merge-ai-prs.mjs:6550`, replace unconditional success with the confirmation result. Before the existing landing bookkeeping, an unconfirmed result sets the remaining candidate to skip, leaves dependents blocked and appends `{num, repo, headSha, reason}` to an additive JSON `unconfirmed` list. Emit a concise diagnostic without claiming enqueue. Never call the landed trace or credit this candidate on that branch. Existing independent candidates may continue.
4. Reuse `collectQueueMerged` and `confirmQueueFollowUps` for durable recovery. The collector already runs before post-land work at `we:scripts/merge-ai-prs.mjs:6679`. For a pending candidate already in this pass's merged list, return it for completion tracking without appending/crediting it again. Join facts by repo plus number, not number alone; preserve the existing queue path's behavior. Keep pending entries until post-land completion succeeds; failed work remains subject to the existing retry cap. Confirmed delayed land may run follow-up in the same pass or a later one. Do not promise globally exactly-once execution: post-land work is idempotent and can retry.
5. Add an opt-in per-repository fake merge-queue flag in `we:scripts/conveyor/__tests__/helpers/fake-gh-shim.mjs:353`: successful command, observable enqueue event, OPEN PR, unchanged base ref. Normal fake merges remain unchanged. The soak judge must prove the command was attempted so a pass that never reaches the write cannot pass vacuously.

## MVP

- Must: strictly confirm direct writes before landing credit, trace, dependency release or candidate-specific post-land effects, for every PR content kind.
- Must: persist recovery intent before writing; errors refuse that write and preserve existing state. Never turn unknown state into landed or positively queued output.
- Must: recover delayed merges even after they vanish from open listings; prevent duplicate same-pass credit and cross-repository number collisions. Retire only after successful follow-up, retaining existing retry behavior.
- Must: executable CLI regression, fake-gh regression and daemon soak break with normal-merge control.
- Could, deferred: bounded fast retries and watcher-triggered follow-up. No queue-policy, ruleset or runbook change; no change to the explicit queue strategy's enqueue decision or clearance behavior.

## Test plan

- `we:scripts/__tests__/merge-ai-prs.test.mjs`: retain the existing resolution-basis comments and default-base hold regressions when changing the shared drain entry point.
- `we:scripts/conveyor/soak/breaks/__tests__/drain-records-enqueued-pr-as-landed.test.mjs` (new): unit-test the planned break judge with synthetic observations. Reject no merge attempt, OPEN with landed effects, and missing pending recovery; accept an observed enqueue with OPEN state, no landed effects and retained pending intent. Cover the delayed-merge and normal-merge control observations separately. Retain the sibling soak test for real daemon execution.

- `we:scripts/__tests__/merge-ai-prs-confirm-merged-before-landed.test.mjs` (new): spawn the real CLI using the isolated subprocess pattern in `we:scripts/__tests__/merge-ai-prs-merge-failure-isolation.test.mjs:48`. Stub a successful direct merge that stays OPEN. Assert the write actually ran, JSON merged excludes it, unconfirmed includes it, no landed comment or candidate post-land work occurs, and a dependent remains blocked. Inspect command/event logs and dependency behavior rather than pretending the private landedThisPass set is exported. Include an unrelated confirmed merge as a control.
- In that CLI test, cover normal MERGED, command failure, malformed/empty/error confirmation, OPEN with a misleading mergedAt, explicit local and sibling repository argv, and source/docs/config/data candidates. Simulate MERGED on the next pass with the PR absent from open listings: pending recovery must still drive follow-up. Verify successful completion retires it, subsequent passes do not repeat it, and failed completion keeps it pending.
- `we:scripts/lib/__tests__/drain-merge-strategy.test.mjs`: pending registration in direct mode; absent/corrupt state; lock refusal/write failure; preservation of concurrent entries; no nested lock acquisition; same-pass merge deduplication; identical PR numbers in two repos; OPEN/read-error retention; CLOSED retirement; failed completion and retry cap. Assert no merge write is allowed when registration fails via the CLI test too.
- `we:scripts/conveyor/__tests__/fake-gh-state.test.mjs`: opt-in enqueue leaves PR OPEN and base unchanged, emits its event, and normal merge still updates both. Keep the flag repository-scoped.
- `we:scripts/__tests__/merge-ai-prs-merge-trace-post-confirm.test.mjs`: retain existing pre-check and exception-recovery coverage; update source anchors only where required, with the new executable regression supplying behavioral proof.
- `we:scripts/conveyor/soak/breaks/drain-records-enqueued-pr-as-landed.mjs` plus `we:scripts/conveyor/soak/breaks/drain-records-enqueued-pr-as-landed.soak.test.mjs` (new): follow `we:scripts/conveyor/soak/breaks/couple-split-by-unrelated-merge.mjs:124` and its sibling test. Run the real drain daemon with direct strategy and fake queued merges; judge the observed enqueue attempt, OPEN state, absence of landed trace/resolution and retained pending entry. Include a delayed-merge phase and normal-merge control.

## Proof plan

- Implementation proof must execute the real write path, not just inspect source. With the fake enqueue support present, the CLI regression and soak case must fail against the old unconditional-success branch because it claims land while OPEN; capture that observation. Against the fix, capture the same attempted enqueue without land credit, then successful deferred follow-up and the normal-merge control.
- Run each scoped test through the host heavy-run queue using `we:scripts/readiness/heavy-admission.mjs` with `run -- npx vitest run` and the test's WE-relative path. Run `npm run check:standards` through that same queue. No bare test or soak runner invocation.
- After a fix commit exists, record its SHA in the break's fixedBy metadata and use `we:scripts/conveyor/soak/red-green.mjs` through heavy admission according to its CLI usage. Preserve the harness addition when reverting the fix so RED proves false landing rather than missing fixture support. Attach red/green command output and state/event evidence to the implementation review. This preparation does not supply an implementation SHA or claim those tests have passed.
- A dry-run pass is only an output smoke check; it cannot prove merge confirmation. The runner owns this preparation's stamping and checks.

## Follow-ups

- Add bounded confirmation retries outside the writer lock if measured latency warrants it; retain durable intent and fail-closed behavior.
- Trigger pending follow-up from the watcher between full passes, preserving completion acknowledgment and retry limits.
- Surface unconfirmed direct writes in daemon status and the queue UI without labelling unknown outcomes as queued.
- Remove the merge-queue switch runbook precondition only after this fix's executable proof lands.
