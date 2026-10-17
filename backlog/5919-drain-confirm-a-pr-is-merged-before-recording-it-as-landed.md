---
bornAs: xsvxy4v
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/__tests__/merge-ai-prs-confirm-merged-before-landed.test.mjs", "we:scripts/__tests__/merge-ai-prs-merge-trace-post-confirm.test.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/conveyor/__tests__/helpers/fake-gh-shim.mjs", "we:scripts/conveyor/__tests__/helpers/fake-gh.mjs", "we:scripts/conveyor/__tests__/fake-gh-state.test.mjs", "we:scripts/conveyor/soak/breaks/drain-records-enqueued-pr-as-landed.mjs", "we:scripts/conveyor/soak/breaks/drain-records-enqueued-pr-as-landed.soak.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/drain-records-enqueued-pr-as-landed.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-16"
preparedAgainstSha: "1aba0878aeff904dec8963fee888b3bafcda48ca"
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

- Rechecked at checkout `1aba0878aeff904dec8963fee888b3bafcda48ca`. Old premise: successful direct writes are credited without a fresh MERGED read. Corrected premise: that defect remains at `we:scripts/merge-ai-prs.mjs:6676`, followed by unconditional success and landing credit at `we:scripts/merge-ai-prs.mjs:6711`; the direct path now also writes ledger clearing facts at `we:scripts/merge-ai-prs.mjs:6712`. Those facts must be behind confirmation too. This is source inspection, not a live GitHub enqueue reproduction or an already-delivered fix.
- Corrected stale citations from the previous preparation: writer 6650 → 6676, bookkeeping 6682 → 6711, pre-check 4658 → 4667, collection 6784 → 6815, injected fail-closed state lock 4528 → 4539, pinned head 6604 → 6630, all in `we:scripts/merge-ai-prs.mjs`. The pre-check still accepts MERGED **or** truthy mergedAt; it is not a strict post-write confirmation helper.
- Old scope: twelve paths covering the drain, strategy, two fake-gh helpers, break and seven tests. Corrected scope retains those same paths; no implementation has moved out of that touch set. Fixture construction now selects repository fields at `we:scripts/conveyor/__tests__/helpers/fake-gh.mjs:873`; intercept fake queued writes before the actual commit creation at `we:scripts/conveyor/__tests__/helpers/fake-gh-shim.mjs:349`. Four planned files remain absent: confirmation CLI test, break, sibling soak test and break judge unit test. Discovery at `we:scripts/conveyor/soak/breaks/index.mjs:43` requires no registry edit. Each source entry has its matching existing or planned test in scope.
- Recovery joins have moved: `we:scripts/lib/drain-merge-strategy.mjs:382` plans by number, line 386 joins by number alone, and line 393 unconditionally appends to merged. Direct sibling intents require repository-aware joins and same-pass deduplication. Registration must preserve completion tombstones and peer entries under the existing state lock.
- Corrected completion wording: `we:scripts/merge-ai-prs.mjs:6833` can hand post-land work to a durable job; line 6841 then suppresses inline work, while line 7059 computes the current completion predicate. Do not describe a successful handoff as completed execution. Preserve the existing durable handoff contract; test inline failure retention and accepted handoff separately. This card does not redesign the job lifecycle.
- Size remains 3 → 3. Estimate: about 80 changed lines in `we:scripts/merge-ai-prs.mjs`, 90 in `we:scripts/lib/drain-merge-strategy.mjs`, 15 in `we:scripts/conveyor/__tests__/helpers/fake-gh-shim.mjs`, 5 in `we:scripts/conveyor/__tests__/helpers/fake-gh.mjs`, 100 in the planned break, and about 320 across seven scoped test files (140 CLI, 70 strategy, 30 fake-gh, 40 judge, 25 soak, 15 existing drain regressions). The cited write, collector and fixture seams bound the touch set. This is a story, so no estimatedLoc is added. Preparation stamps remain the runner's responsibility.

## Design

1. In `we:scripts/merge-ai-prs.mjs`, add a fresh post-write read of state using the candidate's explicit repository (`c.repo || localSlug`), refusing to write if that identity cannot be resolved. Accept only parsed state MERGED; OPEN, CLOSED, empty/malformed output, contradictory mergedAt-only evidence and read errors are unconfirmed. Do not reuse a cached pre-write read. Use one read, no sleep or polling loop.
2. In `we:scripts/lib/drain-merge-strategy.mjs`, add pending-intent registration using the existing entry metadata (repo, number, head SHA, item, manifest flag, head ref, title). Register before the direct merge write, outside the already-held land callback, through the existing locked read-modify-write machinery. Use the injected lock that refuses unlocked fallback; never acquire it recursively inside the land callback. Store the revalidated head and canonical repository identity, normalizing legacy local null-repo entries against localSlug when comparing keys. Deduplicate by repo plus number, preserve peer entries and followedUp completion keys (including a concurrent completion between registration and writing), and refuse the merge when the state file is unreadable, the lock is refused or the write fails. An absent file may be created. A pending intent is not evidence of enqueue or land. Retain it on command failure or unknown outcome: subsequent confirmed MERGED/CLOSED determines recovery or retirement.
3. At the direct write site in `we:scripts/merge-ai-prs.mjs:6676`, replace unconditional success with the confirmation result. Before the existing landing bookkeeping, an unconfirmed result sets the remaining candidate to skip, leaves dependents blocked and appends `{num, repo, headSha, reason}` to an additive JSON `unconfirmed` list. Emit a concise diagnostic without claiming enqueue. Return an unconfirmed result rather than throwing into the permissive existing exception-recovery check. Never call the landed trace, write direct-land ledger clearing facts, or credit this candidate on that branch. Pre-write audit comments and stacked-PR retargeting remain pre-write actions; the regression must distinguish those from claims of successful land. Existing independent candidates may continue.
4. Reuse `collectQueueMerged` and `confirmQueueFollowUps` for durable recovery. The collector already runs before post-land work at `we:scripts/merge-ai-prs.mjs:6815`. For a pending candidate already in this pass's merged list, return it for completion tracking without appending/crediting it again. Carry repository identity through planning (or plan each repository separately), and join facts by repo plus number, not number alone; preserve the existing queue path's behavior. Report recovered direct intents as direct-write recovery rather than asserting GitHub queue provenance. Keep pending entries until inline post-land completion succeeds or the existing durable job handoff accepts responsibility; a handoff is not proof of completed execution. Failed inline work remains subject to the existing retry cap, and detached work retains its existing job-owned recovery. Confirmed delayed land may run follow-up in the same pass or a later one. Do not promise globally exactly-once execution: post-land work is idempotent and can retry.
5. Add an opt-in per-repository fake merge-queue flag in `we:scripts/conveyor/__tests__/helpers/fake-gh-shim.mjs:349`: successful command, observable enqueue event, OPEN PR, unchanged base ref. Thread the opt-in flag through repository construction in `we:scripts/conveyor/__tests__/helpers/fake-gh.mjs:873`; expose fixture configuration for the soak setup. Normal fake merges remain unchanged. The soak judge must prove the command was attempted so a pass that never reaches the write cannot pass vacuously.

## MVP

Deliver as one implementation change with its executable regression and soak fixture; keep the confirmation and durable recovery together so refusing early credit cannot strand a later merge.

- Must: strictly confirm direct writes before landing credit, trace, dependency release or candidate-specific post-land effects, for every PR content kind.
- Must: persist the explicit repository and revalidated head in recovery intent before writing; errors refuse that write and preserve existing state. Never turn unknown state into landed or positively queued output.
- Must: recover delayed merges even after they vanish from open listings; prevent duplicate same-pass credit and cross-repository number collisions. Retire after successful inline follow-up or accepted durable handoff, retaining existing retry behavior and job-owned recovery.
- Must: executable CLI regression, fake-gh regression and daemon soak break with normal-merge control.
- Could, deferred: bounded fast retries and watcher-triggered follow-up. No queue-policy, ruleset or runbook change; no change to the explicit queue strategy's enqueue decision or clearance behavior.

## Test plan

- `we:scripts/__tests__/merge-ai-prs.test.mjs`: retain the existing resolution-basis comments and default-base hold regressions when changing the shared drain entry point.
- `we:scripts/conveyor/soak/breaks/__tests__/drain-records-enqueued-pr-as-landed.test.mjs` (new): unit-test the planned break judge with synthetic observations. Reject no merge attempt, OPEN with landed effects, and missing pending recovery; accept an observed enqueue with OPEN state, no landed effects and retained pending intent. Cover the delayed-merge and normal-merge control observations separately. Retain the sibling soak test for real daemon execution.

- `we:scripts/__tests__/merge-ai-prs-confirm-merged-before-landed.test.mjs` (new): spawn the real CLI using the isolated subprocess pattern in `we:scripts/__tests__/merge-ai-prs-merge-failure-isolation.test.mjs:49`. Stub a successful direct merge that stays OPEN. Assert the write actually ran, JSON merged excludes it, unconfirmed includes it, no landed trace, direct-land ledger clearing facts or candidate post-land work occurs, and a dependent remains blocked. Inspect command/event logs and dependency behavior rather than pretending the private landedThisPass set is exported. Include an unrelated confirmed merge as a control.
- In that CLI test, cover normal MERGED, command failure, malformed/empty/error confirmation, OPEN with a misleading mergedAt, explicit local and sibling repository argv, and source/docs/config/data candidates. Simulate MERGED on the next pass with the PR absent from open listings: pending recovery must still drive follow-up. Verify successful inline completion retires it, subsequent passes do not repeat it, and failed inline completion keeps it pending. Cover detached-job mode: OPEN must never trigger a handoff for this candidate; confirmed recovery may hand off under the existing contract, with durable job tracking rather than a false claim of completed execution.
- `we:scripts/lib/__tests__/drain-merge-strategy.test.mjs`: pending registration in direct mode; absent/corrupt state; lock refusal/write failure; preservation of concurrent entries and completion keys; registration followed by another drain completing before this writer acquires its lock; no nested lock acquisition; same-pass merge deduplication; legacy null-repo normalization; revalidated-head persistence; identical PR numbers in two repos; OPEN/read-error retention; CLOSED retirement; failed completion and retry cap. Assert no merge write is allowed when registration fails via the CLI test too.
- `we:scripts/conveyor/__tests__/fake-gh-state.test.mjs`: opt-in enqueue leaves PR OPEN and base unchanged, emits its event, and normal merge still updates both. Keep the flag repository-scoped.
- `we:scripts/__tests__/merge-ai-prs-merge-trace-post-confirm.test.mjs`: retain existing pre-check and exception-recovery coverage; update source anchors only where required, with the new executable regression supplying behavioral proof.
- `we:scripts/conveyor/soak/breaks/drain-records-enqueued-pr-as-landed.mjs` plus `we:scripts/conveyor/soak/breaks/drain-records-enqueued-pr-as-landed.soak.test.mjs` (new): follow `we:scripts/conveyor/soak/breaks/couple-split-by-unrelated-merge.mjs:124` and its sibling test. Run the real drain daemon with direct strategy and fake queued merges; judge the observed enqueue attempt, OPEN state, absence of landed trace/resolution and retained pending entry. Include a delayed-merge phase and normal-merge control.

## Proof plan

- Implementation proof must execute the real write path, not just inspect source. With the fake enqueue support present, the CLI regression and soak case must fail against the old unconditional-success branch because it claims land while OPEN; capture that observation, including the command attempt, PR state, merged output, trace comments and pending state. Against the fix, capture the same attempted enqueue without land credit, then successful deferred follow-up and the normal-merge control.
- Run each scoped test through the host heavy-run queue using `we:scripts/readiness/heavy-admission.mjs` with `run -- npx vitest run` and the test's WE-relative path. Run `npm run check:standards` through that same queue. No bare test or soak runner invocation.
- After a fix commit exists, record its SHA in the break's fixedBy metadata and use `we:scripts/conveyor/soak/red-green.mjs` through heavy admission according to its CLI usage. Preserve the harness addition when reverting the fix so RED proves false landing rather than missing fixture support. Attach red/green command output and state/event evidence to the implementation review. This preparation does not supply an implementation SHA or claim those tests have passed.
- A dry-run pass is only an output smoke check; it cannot prove merge confirmation. The runner owns this preparation's stamping and checks.

## Follow-ups

These are deferred enhancements; none gates the immediate confirmation and recovery contract.

- Keep any broader tightening of the existing pre-write and exception-recovery mergedAt checks separate from this successful-write fix.
- Add bounded confirmation retries outside the writer lock if measured latency warrants it; retain durable intent and fail-closed behavior.
- Trigger pending follow-up from the watcher between full passes, preserving completion acknowledgment and retry limits.
- Surface unconfirmed direct writes in daemon status and the queue UI without labelling unknown outcomes as queued.
- Remove the merge-queue switch runbook precondition only after this fix's executable proof lands.
