---
bornAs: xvkpykk
kind: task
parent: "2405"
relatedTo: ["3007"]
status: resolved
scope: ["we:scripts/pr-land.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/review-ledger-check.mjs", "we:scripts/lib/verdict-ledger.mjs", "we:scripts/__tests__/pr-land.test.mjs", "we:scripts/__tests__/merge-ai-prs-drain-verdict-ledger.test.mjs", "we:scripts/__tests__/review-ledger-check.test.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs"]
scopeRationale: "The we:scripts/merge-ai-prs.mjs wiring is covered by the dedicated drain verdict-ledger suite named in scope; the general we:scripts/__tests__/merge-ai-prs.test.mjs suite is deliberately left out of the lease because it is not edited by this item."
dateOpened: "2026-09-23"
dateResolved: "2026-10-08"
preparedDate: "2026-10-02"
preparedAgainstSha: "e7d2d9cad6017871fe726fa4a519534de741e8e5"
tags: []
---

# three hold-label writers bypass the verdict ledger, leaving PRs with no row

Close producer and drain hold-writing gaps and repair existing unledgered holds before #3007 can make the ledger authoritative. The producer actually has two entrances: scored escalation and explicit park. Preserve current label authority and review policy; this item records decisions, not new clearance rules.

## Progress

Preparation checked the current checkout against the original 2026-09-23 review premise:

- **Old premise:** producer hold at line 921, manifest re-park at 4064, test-gaming re-park at 4115. **Corrected evidence:** scored producer escalation applies its label without a verdict write at we:scripts/pr-land.mjs:1048-1054; explicit park also does so at we:scripts/pr-land.mjs:1126-1132. Manifest and test-gaming parks apply labels at we:scripts/merge-ai-prs.mjs:4740-4744 and we:scripts/merge-ai-prs.mjs:4824-4828, then leave through their park branches (we:scripts/merge-ai-prs.mjs:4759-4760, we:scripts/merge-ai-prs.mjs:4841-4842). Neither routes through the ordinary park writer.
- **Main-path qualification:** the ordinary drain park already calls `recordDrainVerdict`, but only inside the new-label predicate (we:scripts/merge-ai-prs.mjs:4921-4928). The helper appends a bearing verdict with drain provenance (we:scripts/merge-ai-prs.mjs:2495-2505). An already-labelled hold therefore needs reconciliation outside that predicate.
- **Checker drift remains:** we:scripts/review-ledger-check.mjs:141-145 still attributes all drain holds to an unwired writer, contradicting the ordinary park call above. Its no-row category includes observed-only history, not just an empty log (we:scripts/review-ledger-check.mjs:70-95).
- **Historical evidence only:** the original card reported PRs #2486 and #2492 as labelled with no rows. Preparation did not repeat that live observation; it is not evidence of their current state. Nor does missing ledger data prove a present merge bypass: the current drain checks review labels (we:scripts/merge-ai-prs.mjs:4526-4537). The ledger-only bypass is a future-authority hazard.
- **Scope correction:** retain the three production files, include the explicit producer park entrance, add the existing ledger owner for a reusable recording/backfill seam, and include four existing test files. This widens mechanical coverage without changing the goal or authorizing the #3007 authority flip.

## Design

1. Use the existing ledger owner, `buildVerdictRecord` and `appendVerdict` (we:scripts/lib/verdict-ledger.mjs:361, we:scripts/lib/verdict-ledger.mjs:870). Factor only the shared recording/backfill mechanics there; preserve the drain wrapper and its provenance. The producer must identify itself as the producer, not claim `declaredActor: drain` / `source: merge-ai-prs` from we:scripts/merge-ai-prs.mjs:2501. Carry actual repo, PR, available head SHA, reason, and decision time; do not manufacture reviewer or human-clearance evidence.
2. Record newly decided holds before label transport, following the existing ordering and fail-soft contract at we:scripts/merge-ai-prs.mjs:4923-4928. Wire both producer entrances and both early-return drain parks. On append failure report the miss and preserve the existing hold action; on label failure retain the decided row so the checker can expose divergence. Dry-run must never append.
3. Reconcile an observed, uncleared hold even when no new label is needed. Use the existing label interpreter and ledger fold (we:scripts/lib/verdict-ledger.mjs:642, we:scripts/lib/verdict-ledger.mjs:550); append a clearly attributed reconciliation record only when there is no current bearing verdict. Observed-only history qualifies, as the checker already specifies (we:scripts/review-ledger-check.mjs:70-95). Cover pending, human, and changes holds, including ordinary wait-author processing; do not require `gate.applyLabel` to be non-null. Repeated processing must not append duplicates. Existing bearing verdicts, including conflicting acceptance, are not rewritten by missing-row repair; fresh explicit re-park decisions still append their actual new verdict.
4. Reconcile in producer/drain paths that already observe held PRs, outside the label-add predicate. Do not make the read-only checker a mutator: its contract is explicit at we:scripts/review-ledger-check.mjs:8-9. Checker output should describe missing producer/drain/history coverage and remediation without claiming it diagnosed which writer caused a particular missing row.

## MVP

Deliver recording at all four concrete entrances, missing-bearing-row reconciliation on encountered held PRs, and corrected checker guidance. Retain current label-based gating, human-clearance rules, and fail-soft writes. Storage migration, a global historical sweep, and the authority flip are outside this slice. The shared helper belongs in the existing ledger owner; no separate storage system or policy abstraction is needed.

## Test plan

- Extend we:scripts/__tests__/pr-land.test.mjs:406 park-mode coverage with recording assertions for explicit pending/human park and scored escalation. Exercise the production orchestration with injected/stubbed forge transport and an isolated ledger; a test calling only the append helper cannot prove either entrance is wired.
- Extend we:scripts/__tests__/merge-ai-prs-drain-verdict-ledger.test.mjs:55 and :61: drive manifest and test-gaming re-parks through their actual branches, assert HUMAN rows, exact reasons, repo/PR/head and drain provenance. Preserve ordinary and stale-acceptance park coverage. Test a label already present and a wait-author changes hold with no apply-label instruction.
- Extend we:scripts/lib/__tests__/verdict-ledger.test.mjs for the shared seam, grounded in the fold/append contracts at we:scripts/lib/verdict-ledger.mjs:550 and :870: empty history, observed-only history, repeated repair, existing bearing hold, existing acceptance, and repo isolation. Repair must neither invent clearance nor overwrite an existing verdict.
- For each wiring path prove write-before-label order, transport failure retaining the row, append failure preserving the hold action with diagnostics, and dry-run producing no writes. Use temporary `WE_VERDICT_LEDGER_DIR` storage (we:scripts/lib/verdict-ledger.mjs:824-825), never the operator ledger.
- Update we:scripts/__tests__/review-ledger-check.test.mjs:106 to require accurate no-row guidance, no obsolete universal drain diagnosis, and unchanged comparison/exit semantics. Assert fold plus checker comparison becomes agreement for the successful formerly unledgered fixtures (we:scripts/review-ledger-check.mjs:86-95).

## Proof plan

Run the four scoped suites via `npx vitest run` with the repo-relative forms of the four test paths in scope. First add the wiring regressions and capture failures on the pre-fix tree, then capture passing output after implementation. Preserve the temporary ledger rows and stubbed transport trace for each entrance to demonstrate actual orchestration, not merely source-text matches or helper round-trips.

Run `npm run check:standards` and the lane verification command from the WE root (entrypoint we:scripts/verify-lane.mjs:26-28). For a later authorized operational observation, run the read-only checker with `--repo=<owner/name> --json --all` (we:scripts/review-ledger-check.mjs:30-32), reporting unledgered and disagreement counts separately. Exit zero alone is insufficient: its contract permits benign discrepancies (we:scripts/review-ledger-check.mjs:23-28). Do not mutate live PRs or claim a clean historical population from isolated fixtures. Phase-2 readiness still needs repeated clean observations (we:scripts/review-ledger-check.mjs:151-153).

## Done when

All four entrypoint regressions fail before implementation and pass after; encountered hold labels with no bearing row gain exactly one accurate reconciliation row; existing bearing history is preserved; dry-run and failure cases pass; checker guidance matches actual coverage. The four scoped suites, standards gate, and lane verification pass. Preparation itself changes only this card and supplies no runtime implementation.

## Follow-ups

- Track repeated operational checker evidence with #3930; this card does not certify or execute the authority flip.
- Inventory historical holds outside producer/drain candidate coverage before claiming complete backfill. A dedicated population sweep, if needed, is separate work; the checker remains read-only (we:scripts/review-ledger-check.mjs:8-9).
- Testing lesson: preserve tests that enter the orchestration branches, since the existing helper-level tests at we:scripts/__tests__/merge-ai-prs-drain-verdict-ledger.test.mjs:55-58 can pass while an early-return writer remains disconnected. Keep this lesson here rather than editing shared agent documentation.
