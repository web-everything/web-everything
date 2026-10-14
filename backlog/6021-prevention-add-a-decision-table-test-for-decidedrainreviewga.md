---
bornAs: xobnfjb
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/drain-review-gate-decision-table.test.mjs", "we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs", "we:scripts/lib/__tests__/human-clearance-carry.test.mjs"]
dateOpened: "2026-10-13"
preparedDate: "2026-10-14"
preparedAgainstSha: "550744d9432c01b326c3f5fac594a4452396e068"
tags: []
---

# Prevention — Add a decision-table test for decideDrainReviewGate that crosses each review label (changes, pend… (from web-everything/web-everything#4965 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:840` — Add a decision-table test for `decideDrainReviewGate` that crosses each review label (`changes`, `pending`, `human`, `accepted`, none) with workflow and non-workflow files and pins the intended action. Alternatively, evaluate the hold after `decideReviewGate` returns `wait-author`.
2. `we:scripts/merge-ai-prs.mjs:854` — Make `filesComplete === true` and a matching non-empty `listedHeadSha` required to trust a listing (anything else triggers the pinned read), plus a unit test for the files-only shape. Optionally a check:standards rule that forbids defaulting evidence-completeness flags to true.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4965@c8971d7d3641c3bdc88ca30c4cc17eea4818e431

## Acceptance

- [A1] The planned we:scripts/__tests__/drain-review-gate-decision-table.test.mjs pins all ten label × file-category outcomes below. Its files-only and missing-listing-head regressions fail against the current implementation and pass with the stricter evidence check; a missing test file alone is not RED evidence.
- [A2] Unknown listing evidence triggers a pinned read when local and enabled, or defers without a label change when no trustworthy read is possible. Explicit `off` retains its existing bypass behavior.
- [A3] Existing acceptance and human-clearance tests keep their original assertions with explicit, per-view listing evidence.

## Non-goals

- Do not reorder the workflow hold after `decideReviewGate`; preserve existing review policy and the `workflowOnly` early-return behavior.
- Do not add the optional standards lint, change the pinned reader, or change production listing construction.

## Edge cases this change must handle

1. **Untrusted text** — no new shell execution or endpoint. Inject all subprocess calls in tests; the existing pinned reader validates the head and base and uses `--end-of-options` (we:scripts/lib/merge-queue-enqueue.mjs:220).
2. **Truncated reads** — absent/false completeness cannot prove a non-workflow listing is complete. Pinned reads may reveal a workflow omitted from the listing.
3. **Shared state** — no new shared state; the gate is not pure: acceptance reads and human-clearance carry can perform I/O. Test subprocesses must be injected, including any attempted writes.
4. **Fail closed** — with the hold enabled, absent/empty/mismatched listing identity or absent completeness requires fallback; unavailable/failed fallback defers with `applyLabel: null`. Explicit `off` bypasses only the workflow hold, not the review gate.
5. **Identity scoping** — compare the listing head to the acceptance reader's head case-insensitively when acceptance evidence exists; other labels use the listing head for the pinned read.
6. **State over time** — mismatch tests model a head moving between listing and acceptance reads; never substitute the stale listed head for the acceptance head in the fallback.
7. **Who wrote it** — preserve exact-head trusted human clearance and rejection of older/untrusted clearance, covered by we:scripts/__tests__/drain-workflow-edit-replay.test.mjs.

## Design

The current check in we:scripts/merge-ai-prs.mjs:854 accepts an omitted completeness flag and an undefined listing head. Require an array, `filesComplete === true`, a non-empty string `listedHeadSha`, and equality (case-insensitive) with `evidence.headSha` when present. Keep the existing fallback at we:scripts/merge-ai-prs.mjs:857 and hold-before-review ordering at we:scripts/merge-ai-prs.mjs:866. A malformed/non-string listing head must not throw from a lowercase operation; treat it as untrusted evidence.

The fallback reads the acceptance head first, otherwise the listed head. It fetches and diffs that immutable head via we:scripts/lib/merge-queue-enqueue.mjs:220. When local reading is unavailable, the enabled hold defers unknown completeness (we:scripts/lib/drain-workflow-edit-hold.mjs:32). Explicit `off` returns no hold and performs no fallback. The `workflowOnly` fast path at we:scripts/merge-ai-prs.mjs:841 already defers missing completeness to the main path, but does not validate listing identity when completeness is true; preserve that separate existing behavior, rather than claiming this change makes every early-return path validate a SHA.

Production options already carry both fields (we:scripts/merge-ai-prs.mjs:4883; callers at we:scripts/merge-ai-prs.mjs:5299 and we:scripts/merge-ai-prs.mjs:5685). Listing normalization produces a string or null head and a boolean completeness value (we:scripts/merge-ai-prs.mjs:1987). The intended change tightens incomplete caller inputs; valid production-shaped inputs retain their actions.

Use a self-contained fixture modeled on the non-exported replay helper in we:scripts/__tests__/drain-workflow-edit-replay.test.mjs:14. Set `escalate: true`, `workflowEditSetting: 'on'`, `workflowOnly: false`, a complete listing at a fixed 40-hex head, no clearance, and no additional human/deviation inputs. For accepted rows, inject a same-head trusted reviewed marker. Expected actions and labels come from we:scripts/lib/review-escalation.mjs:3053 and the preceding workflow hold:

| Review label | Workflow file | Non-workflow file |
| --- | --- | --- |
| changes | park / human | wait-author / no applied label |
| pending | park / human | park / pending |
| human | park / human | park / human |
| accepted | park / human | merge / no applied label |
| none | park / human | park / pending |

Workflow rows must also assert `workflowEditHold: true` and `humanRequired: true`; action alone cannot distinguish a workflow park from a review park. Paths inside fixture payloads are repository-relative; prose references use the repository prefix.

## MVP

1. Tighten only the listing-trust predicate in we:scripts/merge-ai-prs.mjs:854; preserve fallback and review ordering.
2. Add we:scripts/__tests__/drain-review-gate-decision-table.test.mjs with the ten explicit rows and evidence regression cases below. Never derive expected actions by calling the implementation under test.
3. Update `acceptanceOptions(view)` in we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs:546 with `filesComplete: true` and `listedHeadSha: view.headRefOid`. This also supplies evidence for its missing-clone caller at line 380; do not hard-code one head across rebased/reviewed views.
4. Add matching explicit listing evidence to gate fixtures in we:scripts/lib/__tests__/human-clearance-carry.test.mjs:308 through the carry/refusal cases. Keep all carry, write-count, and refusal assertions intact; do not switch the hold off to make tests pass.

## Test plan

- Ten table rows above, with injected subprocesses rejecting unexpected commands and no real network or writes.
- Files-only non-workflow listing: accepted, same-head evidence, `local: false` → defer/null label (currently merges). With `local: true`, pinned diff reveals a workflow → park/human; assert fetch, commit check, and diff use the accepted head and the diff includes `--no-renames`.
- Parameterize missing/false completeness, absent/null/empty/non-string listing head, and mismatched listing head. With valid acceptance evidence and a local checkout, verify fallback is used. With no checkout, verify defer. For `filesComplete: true` plus undefined head, current code incorrectly skips fallback.
- Matching complete listing, including a case-insensitive matching head → no pinned git read. Mismatch fallback must use the fresh acceptance head, not the stale listing head.
- Fallback exception → defer/null label; non-accepted missing-head input → defer rather than throw. A successful pinned non-workflow read proceeds to the ordinary review result.
- Explicit `off` plus unknown files → accepted same-head row merges with no pinned read; `workflowOnly: true` plus absent completeness and enabled hold → fallback or defer. Preserve the complete non-workflow fast-path control.
- Re-run we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs, we:scripts/lib/__tests__/human-clearance-carry.test.mjs, we:scripts/__tests__/drain-workflow-edit-replay.test.mjs, and we:scripts/__tests__/merge-ai-prs.test.mjs as regression coverage.

## Proof plan

During implementation, add the new tests first and run them against the original predicate through the host heavy-run queue. Capture assertion-level RED for files-only and undefined-head cases, then change the predicate and fixtures and capture GREEN for the same test file plus the four regression files above. No whole-worktree stash or live drain invocation is needed. If using a temporary reverse patch to demonstrate RED, reverse only the predicate and restore it before the final run.

All test runs must use the `run -- npx vitest run` interface of we:scripts/readiness/heavy-admission.mjs, passing the repository-relative spelling of each test path above. Run `npm run check:standards` through that same queue. Record exact commands, exit codes, failing assertions and final summaries. Compare fixed mocked production-shaped inputs before/after: table outcomes stay identical while incomplete evidence changes from unsafe trust to fallback/defer. Changing live PR counts cannot prove this invariant. This preparation edits the card only; the runner owns stamping and preparation checks.

## Follow-ups

- Optional completeness-default lint remains separate: a rule must distinguish deliberate opt-out settings from evidence-completeness booleans before forbidding syntax broadly.
- Any proposal to reorder workflow holds or tighten the complete `workflowOnly` fast path requires separate scope and policy review; neither is needed for this decision-table and default-trust regression fix.

## Progress

2026-10-13 prepare: premise check — still no decision-table test (existing coverage in we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs:596-690 and the replay test is spot cases only) and lines 850-852 still default-trust. Card cites 845/850; code is now at 836/850. Goal unchanged.
2026-10-13 re-prepare: stamp was stale (preparedAgainstSha e1320124 vs main 7372a0e0). Re-checked against current main: the gate and lines 850-852 are unchanged; only the two caller citations moved (5288/5674 → 5314/5700), corrected in Design. Re-stamped.
2026-10-14 re-prepare: stamp stale (7372a0e0 vs main 2f7ed115). Re-checked: gate logic and `!== false` / `=== undefined` defaults unchanged (only the drain concurrency commit 1162e0054 touched the file); no decision-table test exists. Citations shifted and were corrected in Design (836→840, 850-852→854-856, callers →5299/5685, workflowReadOptions →4883). Goal and plan unchanged. Re-stamped.
2026-10-14 re-prepare: stamp stale (7372a0e0 vs main 2f7ed115). Re-checked: gate logic and the `!== false` / `=== undefined` defaults are unchanged (only drain-concurrency commit 1162e0054 touched the file); still no decision-table test. Citations shifted and were corrected in Design (836→840, 850-852→854-856, callers →5299/5685, workflowReadOptions →4883). Goal and plan unchanged. Re-stamped.
2026-10-14 review: adversarial pass fixed MVP 2b (per-view listedHeadSha, missing-clone cases), made the Proof plan dry-run concrete, noted the endpoint and loosening hints are n/a.
2026-10-14 re-prepare: stamp stale (2f7ed115 vs main 9b764e95). Re-checked: lines 854-856 still default-trust (`!== false`), no decision-table test file on main, the gate and hold module unchanged since the last stamp. Design/MVP/Test plan unchanged. Re-stamped.

2026-10-14 probation preparation: old premise/scope was a two-file change (we:scripts/merge-ai-prs.mjs and we:scripts/__tests__/merge-ai-prs.test.mjs), despite the body promising a new table and fixture edits. Corrected scope is the source plus its planned matching table test and the two affected existing fixture suites. Evidence: permissive predicate still present at we:scripts/merge-ai-prs.mjs:854; files-only fixture at we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs:546 and carry fixtures at we:scripts/lib/__tests__/human-clearance-carry.test.mjs:308. File search found no proposed table file; the goal is not already delivered. Retain size 3: approximately 5–10 source lines, 120–180 new table/regression lines, 2–4 acceptance fixture lines, and 10–25 carry fixture lines across four files. This is a story, so no estimatedLoc is added. Corrected listing-normalization citations from 1983/1988 to we:scripts/merge-ai-prs.mjs:1987/1992. Corrected the old claim that explicit off defers (it bypasses at we:scripts/lib/drain-workflow-edit-hold.mjs:33), the claim that the gate is pure, and the overstated workflowOnly identity check. Replaced the unstated table expectations with concrete current-policy outcomes and the nondeterministic live-drain proof with injected head-bound regression evidence. Existing preparation stamps are preserved for the runner; no implementation or tests executed during this preparation.
