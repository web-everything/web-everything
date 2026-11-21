---
bornAs: xkoqlar
kind: story
size: 2
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-21"
preparedAgainstSha: "b145f772647787badaa4208ba5ddc58a68c3bff1"
tags: []
---

# A block ruling on a mandatory referral sends the PR back for changes instead of re-asking

A valid independent current-head block must complete an actionable changes bounce, carrying the original finding and the ruling rationale to the fixer. Preserve unresolved obligations and human authority; do not automatically review the completed unchanged head again.

## Progress

Old premise/scope: the prior preparation described a key-only verdict, an always-pending renderer fallback, and a missing rationale handoff, with eight source/test paths. Current source inspection corrects the first two claims: `we:scripts/lib/jury-core.mjs:3680` already returns blocked finding identities and findings; `we:scripts/operations/review-pr.mjs:3199` transports them, including a legacy-key fallback and promotion of matching deferred findings. `we:scripts/lib/jury-core.mjs:3745` already distinguishes pending obligations from recorded rulings. The old line citations are obsolete. Do not rebuild those mechanisms or undo their newer identity/carry rules.

Corrected premise: the remaining gap is the completed publication handoff. Blocked finding entries omit the counted ruling's rationale/evidence (`we:scripts/lib/jury-core.mjs:3682`), aggregation does not expose those details (`we:scripts/lib/jury-core.mjs:4031`), and the final write-up renders panel findings without a referral section (`we:scripts/operations/review-pr.mjs:1971`). The recording guard still counts only panel findings (`we:scripts/operations/review-pr.mjs:2138`), so a persisted block with a clean fresh panel cannot by itself justify a bounce. The existing operation test reaches confirmation (`we:scripts/operations/__tests__/review-pr.test.mjs:3993`); the deferred-promotion test is not a clean-panel publication replay (`we:scripts/operations/__tests__/review-pr.test.mjs:4250`). These observations establish remaining work, not a verified historical incident diagnosis.

Retain the eight-path scope for the end-to-end handoff; durable I/O and reconciliation source edits are conditional on a failing integrated replay. The durable sink already persists/read-backs records (`we:scripts/operations/review-pr-io.mjs:1290`), and its injected harness includes publication/head/identity failures (`we:scripts/operations/__tests__/review-pr-io.test.mjs:2231`). Reconciliation already owes bounced PRs a fix (`we:scripts/conveyor/reconcile-core.mjs:422`) and refuses finding-less fixes (`we:scripts/conveyor/reconcile-core.mjs:4010`). Its ordinary fix and live-session controls exist at `we:scripts/conveyor/__tests__/reconcile-core.test.mjs:162` and `we:scripts/conveyor/__tests__/reconcile-core.test.mjs:845`.

Keep size 2: expected edits are approximately 50–90 lines in the core, 50–90 in the operation, 80–130 in each of the four existing test files, and at most 20–40 in each conditional I/O/planner source (roughly 460–780 changed lines). No estimatedLoc is added to this story. No runtime settings/defaults or authority policy changes are intended. Existing stamps are left untouched for the runner. No implementation tests have been run during this card-only preparation.

The reported #3490 incident, 33 dispatches, and responder-journal size remain unverified context. Do not use the old responder citation as a current-code diagnosis. #4815's verification work is already represented in the sink; preserve it instead of assuming it still requires a coordinated renderer change.

## Design

1. Extend the existing validated blocked-finding projection with counted ruling provenance: source run/key, reviewed head, reviewer or operator identity, rationale and evidence. Resolve through `we:scripts/lib/jury-core.mjs:3571`, retaining operator supersession, independence, readable-card, carry and linked-finding checks. Linked blocks must retain their actual backing source rather than inventing a reviewer rationale. Aggregate these details at `we:scripts/lib/jury-core.mjs:4031`; keep the persisted record format compatible.
2. Carry that projection through the existing referral verdict at `we:scripts/operations/review-pr.mjs:3194`. Preserve existing finding identity and deferred promotion behavior. Render a distinct mandatory-referral section in `we:scripts/operations/review-pr.mjs:1971`, with actionable finding, counted ruling rationale/evidence and provenance. Do not invent panel votes. Deduplicate repeated snapshots using existing identities while retaining distinct counted source rulings.
3. Let validated actionable referral evidence satisfy the empty-panel bounce guard in `we:scripts/operations/review-pr.mjs:2138`; do not synthesize an operator override. Legacy key-only results may still hold acceptance but cannot fabricate ruling details: recover from durable validated records, or retain an explicit incomplete-evidence hold requiring a fresh read/operator intervention. Never publish a supposedly completed rationale-bearing bounce from incomplete evidence.
4. Preserve the pending/blocked acceptance refusal at `we:scripts/operations/review-pr.mjs:2119`. Preserve unrelated human-required verdicts and the existing acceptHeld-specific exception at `we:scripts/operations/review-pr.mjs:3221`. A block does not clear another pending key. Use the existing unattended changes answer, whose policy lives in `we:scripts/lib/review-loop-policy.mjs:105`; no new retry policy or default is needed.
5. Publish through the ordinary operation/sink path and feed the actual comment and labels into reconciliation. A completed bounced head owes a fix, with live-agent deduplication, not another review. After a fix pushes and rearms a new head, review is eligible again. Change the I/O/planner sources only if this replay reveals a defect; retain budget, head and authority guards.

## MVP

Ship the validated ruling-detail projection, final changes section and clean-panel recording support, backed by one synthetic #3490-shaped operation → durable sink → published changes → reconciliation replay. Include restart from a persisted block. Do not implement a responder journal, daemon, new confidence policy or finding-identity redesign. Existing resolved-status wording needs no replacement.

## Acceptance

Each proposed named regression below must fail on the pre-build implementation because its positive completed-handoff assertion is absent or refused, and pass after the build. Negative/control branches run inside the same regression; existing passing guards alone are not red-to-green proof.

- [A1] Executable: proposed test `4846 counted ruling details survive final changes publication` in `we:scripts/operations/__tests__/review-pr.test.mjs`. Drive confirmation, staging and recording; assert original finding, rationale, evidence, head and reviewer in the actual changes body, unchanged panel votes, changes labels and no acceptance marker. Parameterize source/docs/config/data findings.
- [A2] Executable: proposed test `4846 persisted block completes with a clean fresh panel` in `we:scripts/operations/__tests__/review-pr.test.mjs`. Resume with no repeated panel finding and no operator reason; assert an actionable completed bounce through the ordinary unattended changes answer. Include legacy key-only result recovery and incomplete-evidence refusal. This covers existing callers and resumed old state without changing defaults.
- [A3] Executable: proposed test `4846 counted provenance excludes invalid and superseded rulings` in `we:scripts/lib/__tests__/jury-core.test.mjs`. Assert the new projection for a valid block, then malformed/stale/wrong-subject/non-independent/conflicting/unreadable-card variants, explicit operator supersession and linked-block backing. Invalid evidence must never be projected as a counted completed block.
- [A4] Executable: proposed test `4846 completed bounce preserves other holds` in `we:scripts/operations/__tests__/review-pr.test.mjs`. Start with the successful rationale-bearing bounce, then add an unresolved key or unrelated human-required verdict; assert no automated completed bounce/acceptance across those holds. Preserve the existing acceptHeld exception separately.
- [A5] Executable: proposed test `4846 restart publishes one actionable bounce from one judge attempt` in `we:scripts/operations/__tests__/review-pr-io.test.mjs`. Reuse the durable harness with fresh run IDs and sink instances; complete the real operation publication with rationale, assert one mandatory judge invocation, and test interrupted publication recovery plus post/read-back/head-change failures retaining an explicit hold and never false completion.
- [A6] Executable: proposed test `4846 published referral bounce routes to fix until rearmed new head` in `we:scripts/conveyor/__tests__/reconcile-core.test.mjs`. Obtain the body/labels from the real operation/sink replay, assert rationale reaches the fixer input, exactly one eligible fix, no duplicate while live, no review on repeated unchanged-head ticks, and fresh review after push/rearm. Keep caps and liveness controls enabled. A hand-authored substitute comment is not proof of this guarantee.

## Test plan

Implement A1–A6 in the four existing scoped test files, reusing their injected forge effects; do not require live PR writes. Extend the core protocol tests at `we:scripts/lib/__tests__/jury-core.test.mjs:1578`, operation confirmation cases at `we:scripts/operations/__tests__/review-pr.test.mjs:3993`, durable harness at `we:scripts/operations/__tests__/review-pr-io.test.mjs:2231`, and bounced planner cases at `we:scripts/conveyor/__tests__/reconcile-core.test.mjs:162`.

Use unique sentinel rationale/evidence strings to prove they came from the counted ruling, not the finding summary. Cover duplicate snapshots and active supersession without erasing separate findings. Preserve existing controls for ledger publication, bounded records, unavailable comments, human labels and new-head freshness. No new settings, costs or concurrency knobs are introduced.

## Proof plan

For implementation, run each scoped file through the host queue using `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <scoped-test-file>`; repository-prefixed command paths here denote WE-relative paths and must have the `we:` locus removed when executed from WE. The four concrete test arguments are `we:scripts/lib/__tests__/jury-core.test.mjs`, `we:scripts/operations/__tests__/review-pr.test.mjs`, `we:scripts/operations/__tests__/review-pr-io.test.mjs`, and `we:scripts/conveyor/__tests__/reconcile-core.test.mjs`.

First run the new tests against unchanged production sources to capture the expected missing-detail/refused-bounce failures, then against the implementation. Record command, exit status and failed/passed named assertions. Capture durable snapshots, judge count, verdict, complete published body, label transitions, fixer inputs, repeated-tick decisions and new-head behavior. Use actual operation/sink/planner code with injected external effects. Queue the standards gate with `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards`. The runner owns preparation checks and stamping; this preparation does not execute the future build proofs.

If queue admission is busy, wait once using its supported wait option and stop/report if still unavailable. The historical incident replay is optional follow-up, not a substitute for the required synthetic replay and not a reason to claim the old incident's cause was proven.

## Follow-ups

Obtain pinned #3490 head, juror output, structured ruling history and comments to reconcile the historical dispatch count; distinguish multiple durable snapshots from distinct review invocations. Any broader retry/confidence policy, change to human authority, or new identity matching belongs in separate work. Record implementation test evidence and any discovered scope correction here. No blockedBy change is proposed by this investigation.
