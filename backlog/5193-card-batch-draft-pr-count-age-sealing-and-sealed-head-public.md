---
bornAs: x2fvt08
kind: story
size: 5
parent: "4703"
status: open
blockedBy: ["5192"]
scope: ["we:scripts/operations/card-batch-io.mjs", "we:scripts/operations/__tests__/card-batch-seal.test.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Card batch draft PR, count/age sealing and sealed-head publication

The #4703 publish half. The first admitted card opens the batch PR as a draft carrying the existing hold label review-status:draft-withdrawn, so the reconcile promote-draft pass (we:scripts/conveyor/reconcile-core.mjs:1806-1810) does not un-draft it on its first green CI and the drain skips it as DRAFT. The PR body is regenerated from durable membership on each append (every card, source, commit). The batch seals when it reaches maxCards (checked at admission) or maxAgeMinutes (checked by a seal-due pass on the existing health-watch tick, beside tmpSweep at we:scripts/conveyor/health-watch.mjs:853, which spawns a detached seal job), even with no new arrival. Sealing records sealedAt, runs verify on the sealed head, removes the hold, marks the PR ready and runs open-pr label-on-green on the same ref, exactly like todays single prevention PR (we:scripts/operations/land-prevention-card.mjs:379-407). A card arriving after seal starts a new batch.

## Done when

1. **Executable** — `npx vitest run` over we:scripts/operations/__tests__/card-batch-seal.test.mjs and we:scripts/conveyor/__tests__/health-watch.test.mjs passes (strip the `we:` prefix to execute), with real git repos, an injected clock and a recording forge adapter.
2. **Must** — the first admission opens the PR as a draft with `review-status:draft-withdrawn`; a reconcile plan over that PR with green checks yields no `promote-draft` row (assert against the planner in we:scripts/conveyor/reconcile-core.mjs, not a stub).
3. **Must (count seal)** — the 10th admission seals in the same call; the 11th card opens batch 2 on a new ref.
4. **Must (age seal)** — a 1-card batch at 120 min is sealed by the seal-due pass with no new arrival; at 119 min it is not.
5. **Must (refuse on error)** — a red verify on the sealed head leaves the PR draft and held, records the reason, and never labels it `ready-to-merge`; a sealed head that changes after verify invalidates that verify.
6. **Must** — the PR body lists every member card, its source PR/head and its commit sha, regenerated from durable membership.
7. **Executable** — `npm run check:standards` green.

## Build checklist

- [ ] Open the draft through the `open-pr` operation (pr-land opens `park` as draft by default, we:scripts/pr-land.mjs:52, and re-runs on an existing PR, we:scripts/pr-land.mjs:413). If no existing mode opens a label-free draft, add a hold variant in pr-land rather than calling `gh pr create` directly.
- [ ] Seal sequence: record `sealedAt` → `verify --mode=run` on the sealed head → remove hold label → `gh pr ready` → `open-pr --mode=label-on-green` on the same ref (mirror we:scripts/operations/land-prevention-card.mjs:379-407).
- [ ] Age timer: one `attempt('cardBatchSeal', …)` in the health-watch tick beside `tmpSweep` (we:scripts/conveyor/health-watch.mjs:853), spawning a detached seal job (reuse we:scripts/operations/detached-dispatch.mjs); the tick itself never blocks on verify.
- [ ] Measure: record CI runs per append. The CI workflow runs on draft PRs (no draft filter; card-only light path at we:.github/workflows/ci.yml:59-91).
