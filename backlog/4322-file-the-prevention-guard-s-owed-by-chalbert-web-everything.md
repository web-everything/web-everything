---
bornAs: xd6nu9f
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/conveyor/land-overlap-yield.mjs", "we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs", "we:docs/agent/testing.md"]
dateOpened: "2026-09-27"
preparedDate: "2026-10-09"
preparedAgainstSha: "09e2a5802b5492a1bad15b788757b143bf0434e4"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2829's independent review

Filed mechanically on approval of chalbert/web-everything#2829 to retain five prevention obligations: a couple-aware overlap regression and cycle guard; explicit default-branch tests; verification of promised locking behavior; tests of changed IO projections; and verification of new caches. The approval did not block on these obligations. Preparation below distinguishes existing coverage from the remaining work.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2829@37c35df4bc6cacf09fb279169ef50899b709338a

## Progress

- Preparation investigation, 2026-10-09: the old premise cited historical plans in `we:backlog/4308-drain-lands-a-ready-pr-after-not-before-a-larger-overlapping.md:40` and `we:backlog/4306-blocker-two-live-fixers-on-one-pr-reaper-backstop-clobbers-t.md:1`; the old scope contained only those two cards. Those are provenance, not the current implementation or intended edit locations. Both implementation cards are now resolved. This item is not wholly delivered: the composed planner regression and the four explicit test-plan requirements remain.
- Corrected scope: the overlap rule and its drain projection, their existing matching tests, and the testing guidance. `we:scripts/conveyor/land-overlap-yield.mjs:181` describes a per-repository PR order; its pairwise selection at line 220 has no couple membership. `we:scripts/merge-ai-prs.mjs:1976` projects overlap rows without that membership, consumes waits at line 2239, and applies the couple gate later at line 5607. `we:scripts/lib/couple-cascade.mjs:85` propagates partner holds. Consequently, an acyclic order over individual PRs is not proof of acyclicity after couples are treated as indivisible groups. This is source evidence of an uncovered composition, not a claim of an observed production deadlock.
- Existing coverage to retain: the three-single-PR ranking regression in `we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs:109`, absent/unreadable cards at line 245, settings lock acquisition/contention at line 353, history memoization at line 430, and label-cache reuse/head invalidation at line 455. `we:scripts/conveyor/__tests__/session-verdicts-io.test.mjs:33` already verifies session identity projection, matching `we:scripts/conveyor/session-verdicts-io.mjs:114`. Do not reimplement those delivered tests or reopen the resolved cards.
- The existing couple test at `we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs:42` unions a supplied couple wait with a supplied overlap wait; it does not build opposing ranked waits across two couples. `we:docs/agent/testing.md:345` already requires omitted default arguments, but that narrower rule does not enumerate absent configuration/cards, lock contention, changed projections, and cache invalidation in every applicable test plan.
- Size corrected from **3 to 5**: this is no longer a two-card prose edit. It needs membership projection (`we:scripts/merge-ai-prs.mjs:1976`), a composed-graph guard around pairwise waits (`we:scripts/conveyor/land-overlap-yield.mjs:220`), and integration across the subsequent couple gate (`we:scripts/merge-ai-prs.mjs:5607`), plus the reusable test-plan checklist. Each source in scope has its matching existing test file; the documentation entry is verified by checklist review and the standards gate.

## Design

Preserve the ranking and budget policy in [we:docs/agent/platform-decisions.md#drain-overlap-yield-landing-order](docs/agent/platform-decisions.md#drain-overlap-yield-landing-order). Implement the owed **cycle-detection** guard, without inventing a new aggregate size or priority policy for couples.

1. Extend the overlap-row projection in `we:scripts/merge-ai-prs.mjs` with stable, repository-qualified couple identity. Derive membership from existing joined verdicts and manifest repo/ref membership in the full open-PR context, including non-ready carriers; never infer a couple from equal PR numbers. Normalize the local repository slug consistently. Singleton PRs retain their own identity. Already merged members must not introduce fresh waits.
2. In `we:scripts/conveyor/land-overlap-yield.mjs`, compute the existing eligible overlap waits, then check their graph with couple members contracted into one node. Include known hard dependency/stack edges in the cycle check; those edges are never removed. Suppress overlap edges internal to a couple or inside a cyclic strongly connected component. Keep acyclic overlap edges and all existing eligibility, exemption, red-CI, and deadline behavior. This extends the existing exclusion of yields to a dependent target to the composed graph; it does not select a new winner between couples. Unknown membership must not be asserted complete: suppress the affected optional yield rather than risk a cycle. Hard gates and couple atomicity continue to decide whether anything can land.
3. Use the same guarded result for the trial and budgeted overlap passes, initial planning, and every replan. The trial must not fetch label times solely for a yield already excluded by the graph guard. Dry-run and live planning must use identical logic. Keep `we:scripts/lib/couple-cascade.mjs` unchanged: its existing hold propagation and contiguous impl-before-carrier ordering are the consumer to test.
4. Extend the quality guidelines in `we:docs/agent/testing.md` with an applicability checklist for test plans: defaults/absent/malformed inputs; acquisition, contention, failure and release for a promised lock; actual IO projection of newly carried fields plus legacy/missing values; cache cold/warm/invalidation/failure paths with observable IO counts. Every applicable row names a test file and behavioral assertion; inapplicable rows give a reason. Existing tests count. Require composed scheduling tests when a change combines ranking with coupled groups. This is an author/reviewer requirement, not a keyword-based lint pretending to prove behavior.

The lock checklist must describe the real contract. For example, `we:scripts/conveyor/land-overlap-yield.mjs:353` explicitly permits a settings write with `locked:false`; this item does not silently turn that into mandatory exclusion. Likewise, `we:scripts/operations/completion-cli.mjs:118` calls the completion lock: a future change to that path must test the actual call boundary, not only a pure ownership helper.

## MVP

- Add the membership projection and cycle filter in the two scoped source files, with no new settings, network reads, or changes to the merge authorization gates.
- Add deterministic opposing-couple and hard-dependency regressions to the two scoped suites. Preserve existing standalone ranking, timed release, red-target and null-context behavior.
- Add any missing config-read default tests to `we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs`: absent file, malformed JSON, invalid schema, and explicit disabled config must exercise the real reader using temporary files.
- Publish the four test-plan requirements in `we:docs/agent/testing.md`, crediting the already-present cache, lock and projection examples above. No edits to the historical source cards are needed.

## Test plan

1. `we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs`: couple A has WE/impl sizes 100/10; couple B has WE/impl sizes 10/100. Within each repository both PRs overlap, are eligible, ready and inside budget. Raw ranks produce B→A in WE and A→B in impl. Assert no cyclic overlap waits survive contraction, regardless of input permutation. Add same-couple exclusion, an acyclic two-couple case whose yield survives, a three-group cycle, and a cycle combining a hard dependency with an overlap edge; hard dependencies remain intact. Include unknown membership, equal PR numbers in different repos, and expired budgets.
2. `we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs`: construct real listing/manifest/verdict fixtures and pass through the exported row projection, overlap calculation, label planner, and existing couple cascade. Assert the opposing-couple fixture permits a whole eligible couple to progress without splitting it; an independently held member still holds its couple. Repeat after a simulated merge and for a non-ready carrier visible only in full context. Verify local-null repository normalization and null overlap context. Do not supply precomputed waits as the sole proof of wiring.
3. `we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs`: temporary-file config reader cases above; retain and run the existing missing-card, lock and cache tests. Cache evidence must count calls (warm same-head reuse and changed-head reread), not merely compare returned timestamps. No real GitHub API calls or shared lock directories.
4. Review `we:docs/agent/testing.md` against all five original obligations. Confirm each requirement names what to observe and accepts existing coverage. The existing projection test in `we:scripts/conveyor/__tests__/session-verdicts-io.test.mjs` is a retained example, not a planned source edit.

Run targeted suites only through the host queue:

```bash
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/conveyor/__tests__/land-overlap-yield.test.mjs scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs scripts/conveyor/__tests__/session-verdicts-io.test.mjs
node scripts/readiness/heavy-admission.mjs run -- npm run check:standards
```

## Proof plan

At implementation time record the baseline SHA. Run the new opposing-couple regression against that baseline with only the test fixture added: it must fail specifically because the composed waits hold both eligible couples. Then run the same fixture with the guard and record the surviving waits, ready members, and contiguous couple order. A passing standalone ranking test is not this proof. If the baseline does not reproduce, investigate the actual production composition before claiming a fix.

Use fake time and deterministic manifests/listings; no production merge or daemon deployment is required to demonstrate this planner behavior. Show a replan after a simulated merge removing the landed group's influence, plus a negative control where a genuine hard blocker still prevents landing. Record queue command outcomes and verify that the shared initial/replan wiring uses the guard. This proves planner behavior, not measured reductions in production conflict cost or API usage.

## Done when

The opposing-couple regression is red on the recorded baseline and green with the guard; the targeted queued suites and standards gate pass; and the testing guide explicitly carries all four applicability requirements with the composed-scheduler regression requirement. Existing ranking, deadlines, dependency gates and couple atomicity remain covered. Preparation alone does not satisfy these implementation criteria.

## Follow-ups

- Changes to coupled-group ranking or the settings writer's fail-soft lock policy require their own policy discussion; neither is implied by this guard.
- Retain #4308's separate production conflict-cost/budget evaluation. This item supplies deterministic prevention, not a claim that reconciliation work disappears.
- No blockedBy changes are proposed: the cited implementation cards are resolved and the implementation/test seams already exist.
