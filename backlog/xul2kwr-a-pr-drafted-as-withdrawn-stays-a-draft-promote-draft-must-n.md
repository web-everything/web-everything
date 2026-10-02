---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/promote-draft-pr-dispatch.mjs", "we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/review-status-tag.mjs", "we:scripts/conveyor/__tests__/review-status-tag.test.mjs", "we:scripts/conveyor/fix-procedure.mjs", "we:scripts/conveyor/__tests__/fix-procedure.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-10-02"
preparedAgainstSha: "e2a67de93595b433533b3e52a6b3fbd5fb61c7df"
tags: []
---

# A PR drafted as withdrawn stays a draft: promote-draft must never re-ready it

A PR carrying `review-status:draft-withdrawn` must stay out of automatic promotion after its fix claim expires, until the withdrawal is explicitly lifted. Green CI does not lift a withdrawal. Preserve ordinary draft-first promotion and the existing scope-change behavior.

## Progress

- Original report: on 2026-10-02 PR #3432 was reportedly withdrawn at 11:26 AM ET with `fix-begin --draft --reason=withdrawn`, then promoted after claim expiry, followed by about five review runs. Those timings and run counts are filing context, not independently verified incident evidence; use a synthetic #3432 replay below rather than claiming a live replay occurred.
- Premise confirmed in current code: a live fix claim suppresses dispatch at we:scripts/conveyor/reconcile-core.mjs:1505; absent that claim, any green draft reaches promotion at we:scripts/conveyor/reconcile-core.mjs:1639. Expired claims read as null at we:scripts/conveyor/fix-procedure.mjs:121. The executor checks fresh CI but no withdrawal state before `ready` at we:scripts/operations/promote-draft-pr-dispatch.mjs:138-164.
- Original scope listed only the executor and its test, despite mentioning the planner. Corrected scope adds the planner and tests, status-label reconciliation and tests, and fix-procedure comments/release regression coverage. A planner/executor-only guard is insufficient: the tagger derives `awaiting-ci` without a live claim (we:scripts/conveyor/review-status-tag.mjs:133-154), then removes other status labels (we:scripts/conveyor/review-status-tag.mjs:164-169). Its shell reads current labels only after deriving status (we:scripts/conveyor/review-status-tag.mjs:211-213).
- Read-only preparation probes on 2026-10-02: calling the real status derivation/planner for a draft with no claim and the withdrawal label returned `add: review-status:awaiting-ci`, `remove: [review-status:draft-withdrawn]`. Calling the real promotion executor with an injected green plan/check reader and recording provider called `ready(3432)` even with that label in the entry. These exercised we:scripts/conveyor/review-status-tag.mjs:93-169 and we:scripts/operations/promote-draft-pr-dispatch.mjs:105-178 without GitHub writes; they prove the local gaps, not the historical incident sequence.
- The goal agrees with the ratified distinction between withdrawn PRs and fresh draft-first PRs: [we:docs/agent/platform-decisions.md:5790-5800](../docs/agent/platform-decisions.md#fix-claim-draft-only-on-withdrawal). No policy reversal is proposed. Explicit `fix-end` already removes the held reason label (we:scripts/conveyor/fix-procedure.mjs:629-638); claim expiry is not that explicit action.

## Design

1. **Planner:** exclude `review-status:draft-withdrawn` from the green-draft promotion branch at we:scripts/conveyor/reconcile-core.mjs:1639. Return the existing `draft` refusal with an explanatory withdrawal reason for that green draft; retain existing earlier claim refusals and red-draft CI handling. Accept label strings and `{name}` records. Do not turn this into a general stand-down of all work.
2. **Executor:** add an injectable fresh PR-label reader to we:scripts/operations/promote-draft-pr-dispatch.mjs:105 alongside the existing fresh-check seam. Proposed signature: `readPrLabels({repoSlug, prNumber}) -> Array<string|{name:string}>`; default to throttled `gh pr view <number> --repo <slug> --json labels`, validate the envelope and label entries, and return the validated array. Read immediately before `ready`, after successful fresh CI validation, so a withdrawal applied after planning is observed. Present withdrawal produces a structured refusal (`kind: 'draft-withdrawn'`, proposed); failed/malformed reads produce `kind: 'draft-state-unreadable'` (proposed). Both preserve the existing result envelope and skip `ready` and status clearing. A valid empty label array permits promotion. Retain exact-head CI refusal behavior at we:scripts/operations/promote-draft-pr-dispatch.mjs:143-161 and explicit target-repo selection at we:scripts/operations/promote-draft-pr-dispatch.mjs:122-133.
3. **Label lifetime:** make the shared automatic label-change planner preserve an existing withdrawal label instead of replacing/removing it for a derived status, including null. This covers both periodic tagging and dispatch-time status changes through their existing common seam (we:scripts/conveyor/review-status-tag.mjs:213, we:scripts/conveyor/review-status-tag.mjs:254). Keep the withdrawal label mutually exclusive with other automatic status labels. Do not infer withdrawal from an expired claim or create a new persistent store: the existing PR label is the hold.
4. **Explicit release:** retain direct reason-label removal by `fix-end` at we:scripts/conveyor/fix-procedure.mjs:638 and deliberate operator label removal; neither automatic tagging nor TTL expiry is a release. Existing explicit `fix-begin` reason replacement remains at we:scripts/conveyor/fix-procedure.mjs:592-599. Update the misleading expiry/promotion commentary at we:scripts/conveyor/fix-procedure.mjs:37 and distinguish release from expiry beside we:scripts/conveyor/fix-procedure.mjs:617-622. No new release command is needed.
5. **Consumers and delivery:** the CLI consumer at we:skills-src/conveyor/runner.mjs:367 and in-process consumer at we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:250 retain their interfaces; the new reader has a production default. Land the guards, label preservation, and tests together. Existing size 2 reflects a bounded correction using existing seams, with no daemon redesign or new protocol. The read/write gap remains non-atomic at GitHub; the fresh read closes the stale-plan gap, not a withdrawal arriving after that final read.

## MVP

- **Must 1:** a green draft carrying the withdrawal label receives no promotion plan, regardless of whether its fix claim is live, expired, or absent.
- **Must 2:** a stale promotion plan cannot call `ready` or clear status when the fresh labels contain withdrawal, or the fresh label read fails/has invalid data. Valid label absence still requires fresh green CI.
- **Must 3:** automatic status reconciliation preserves the withdrawal label across claim expiry and subsequent ticks; explicit release removes it and restores ordinary eligibility.
- **Must 4:** ordinary green drafts and scope-change drafts keep their existing promotion behavior; red/pending CI and repository targeting retain their current protections. The hold applies equally to source, docs, config, and data PRs; it never depends on changed-file classification.

Build order: add failing fixtures at the existing planner, executor, tagger, and fix-procedure test seams; implement label preservation and planner exclusion; add the fresh executor read and refusal diagnostics; update misleading comments; run the combined replay and gates. All implementation is future work; this preparation changes only the card.

## Test plan

- Extend we:scripts/conveyor/__tests__/reconcile-core.test.mjs:3105 with labelled green drafts (both label representations), with/without a claim, and post-expiry snapshots; assert no promotion or review and an explanatory refusal. Retain the ordinary green/red/pending controls at we:scripts/conveyor/__tests__/reconcile-core.test.mjs:3110-3130.
- Extend we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs:17 with an injected fresh label reader: stale plan followed by withdrawal; thrown read; missing/null/non-array labels; malformed entries; valid empty labels; unrelated labels; scope-change label. Assert zero provider/status-clear calls on refusals and correct repo slug/PR number for reads. Test the default reader's argv and parsing through an injected command seam, with no real GitHub calls. Keep the fresh-check fixtures at we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs:10-14; make all old success fixtures explicitly return valid fresh labels.
- Extend we:scripts/conveyor/__tests__/review-status-tag.test.mjs:198 with a missing/expired claim and existing withdrawal label, repeated ticks, attempted status replacement/clearing, and explicit label removal followed by normal status behavior. Exercise both automatic callers of the shared label planner, not only derivation.
- Extend we:scripts/conveyor/__tests__/fix-procedure.test.mjs:608 with a temporary claim store/fake clock and fake label provider: withdraw, expire beyond TTL, run automatic tag reconciliation, plan promotion, and assert the label remains and no ready effect occurs. Separately verify explicit `fix-end` still removes the held label. Use the real exported functions with fake IO rather than reproducing their conditions in test helpers.

## Done when

1. **Musts 1-4:** the focused regression command passes after implementation, and new withdrawal cases fail against the preparation baseline: `npx vitest run we:scripts/conveyor/__tests__/reconcile-core.test.mjs we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs we:scripts/conveyor/__tests__/review-status-tag.test.mjs we:scripts/conveyor/__tests__/fix-procedure.test.mjs` (strip each `we:` locus prefix when executing from the WE checkout).
2. **Musts 1-3:** the synthetic #3432 sequence records draft/withdrawal surviving claim expiry and repeated tag/planner/executor passes, including withdrawal appearing between planning and execution; zero `ready` and zero status-clear calls until explicit release.
3. **Must 4:** control cases prove ordinary and scope-change green drafts still promote, fresh red/pending checks still refuse promotion, and label reads target the requested constellation repository.

## Proof plan

Capture the focused command's before/after output and the synthetic sequence's label state, planned kinds, refusals, and recorded provider calls. The replay uses we:scripts/conveyor/fix-procedure.mjs:121, we:scripts/conveyor/review-status-tag.mjs:190, we:scripts/conveyor/reconcile-core.mjs:1639, and we:scripts/operations/promote-draft-pr-dispatch.mjs:105 with fake clocks/IO; it must not mutate historical PR #3432. Demonstrate that removing each new guard independently makes its corresponding regression fail. Run `npm run check:standards` and `node we:scripts/verify-lane.mjs` (strip `we:` when executing). Record failures without weakening expectations. This card's preparation probes are baseline evidence only; implementation proof is still owed.

## Follow-ups

- Independent review of the prepared card remains the human handoff before implementation; no independent-review verdict is claimed here.
- Testing lesson: expiry tests must include the automatic label writer before the promotion reader; a durable-hold test that injects a label forever misses the existing stripping path at we:scripts/conveyor/review-status-tag.mjs:164-169.
- Failed initial withdrawal-label writes are a separate limitation: `fix-begin` currently reports them as best-effort steps at we:scripts/conveyor/fix-procedure.mjs:590-601. This card protects a PR carrying the label; guaranteeing hold installation when GitHub rejects that write needs separate work.
- An atomic withdrawal-vs-ready operation is not provided by the current provider port (we:scripts/lib/draft-promote-provider.mjs:64-65). Do not claim this read-before-write change eliminates every concurrent GitHub mutation race.
