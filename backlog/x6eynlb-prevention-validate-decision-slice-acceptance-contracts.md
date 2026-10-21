---
bornAs: x6eynlb
kind: story
size: 8
parent: "4075"
status: open
blockedBy: ["xcq5jb9"]
scope: ["we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs", "we:scripts/lib/__tests__/stack-policy.test.mjs", "we:docs/agent/backlog-workflow.md"]
dateOpened: "2026-10-20"
tags: [prevention, acceptance-coverage]
---

# Prevention — validate decision and slice acceptance contracts (from web-everything/web-everything#5530 review)

Track all prevention owed by the advisory review of web-everything/web-everything#5530 (reviewed head `9d2d3b722be831f3bfe887e3245582e06259eab9`, 2026-10-20). The decision's guard-settings amendment, matrix configurability and rebase gate preservation were not pinned by named planned tests; the epic also omitted a child's test file and failed to encode its slice order. The repair adds those contracts; this card owns the reusable checks below, not the stacking implementation.

## Review prevention mapping

Locations below identify findings on the reviewed head, not current line numbers. Each owed guard maps to the acceptance criterion that implements it.

| Finding location | Lens and owed guard | Acceptance |
| --- | --- | --- |
| `we:backlog/xv85eqi-decision-when-prs-may-stack-base-state-child-size-risk-with.md` | correctness/coverage: map every Skeptic amendment to a named child test, with a review-lens fallback | A1 decision amendments; A3 |
| `we:backlog/xejcrh1-we-stacked-pr-policy-build-configurable-cascade-policy-for-w.md` | correctness/coverage: epic A1 includes every child's A1 test file | A1 epic A1 |
| `we:backlog/xkmrswh-we-stacked-pr-policy-slice-3-drain-ordered-landing-restack-d.md` | correctness/correctness: order siblings with overlapping scopes | A1 sibling scopes |
| `we:backlog/x44bz7l-we-stacked-pr-policy-slice-4-closed-or-rejected-base-handlin.md` | correctness/correctness: missing-setting tests name the default and missing layer | A1 missing setting; A3 |
| `we:backlog/xv85eqi-decision-when-prs-may-stack-base-state-child-size-risk-with.md` | correctness/prose: parent claims and child counts resolve to actual parent fields | A1 parent claims |
| `we:backlog/xcq5jb9-we-stacked-pr-policy-slice-1-policy-settings-and-evaluator.md:20` | security/coverage: categorical Fork and Skeptic exceptions map to named tests, including every gate-read settings file classifying as guard | A1 decision amendments; A2 classification contract; A3 |
| `we:backlog/x44bz7l-we-stacked-pr-policy-slice-4-closed-or-rejected-base-handlin.md:26` | security/coverage: the card template and lint require a gates-unchanged test for PR-head mutation, including closed-base rebase | A1 head mutation; A3 |
| `we:backlog/x44bz7l-we-stacked-pr-policy-slice-4-closed-or-rejected-base-handlin.md:33` | correctness/coverage: a slice that moves a child off its base (rebase, retarget or stack-edge change) names a test through the real `classifyPr` and `planLabelDrain`, never a candidate with a preset decision (round 6 found the stack edge, round 9 the PR base) | A1 base move; A3 |
| `we:backlog/xcq5jb9-we-stacked-pr-policy-slice-1-policy-settings-and-evaluator.md:19` | simplicity/coverage: every configurable matrix cell outside the safety floor demonstrates an effective non-default override | A2 configuration contract |
| `we:backlog/xcq5jb9-we-stacked-pr-policy-slice-1-policy-settings-and-evaluator.md:18` | codex-correctness/coverage: deterministic matrix override tests change outcomes while the independent floor remains enforced | A2 configuration contract |

## Acceptance

- [A1] **Executable** — the following command fails on new negative fixtures before the rules exist and passes after. Wire the rules into `npm run check:standards`.

  ```bash
  npm run test:unit -- scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs
  ```

  Named tests:
  - `decision amendments: every Skeptic AMENDED or SURVIVES-WITH-AMENDMENT clause maps to a named test in an implementing epic child` (follow actual parent fields; include Fork sentences of the form "X counts as" or "never Y", guard-settings classification, and mixed-child precedence). Use explicit clause-to-test references; prose that cannot be checked mechanically must go through the documented review lens and cannot silently count as covered.
  - `epic A1: the test-file set contains the union of all children A1 test files` (include a child with two files and an epic omitting only the drain-ordering file; normalize repo-qualified paths).
  - `sibling scopes: overlapping paths require ordering by blockedBy reachability` (shared file, directory-prefix overlap, disjoint siblings, direct and transitive order, reverse order and cycles; a cycle never satisfies ordering).
  - `missing setting: a fail-closed test states both the cascade default and which layer or resolved result is missing` (unset repo layer with a default is distinct from no resolved value or an unreadable cascade).
  - `parent claims: child counts and parent-edge assertions resolve to actual parent fields` (wrong parent, stale count, missing card and a corrected four-child epic).
  - `head mutation: a slice scoping we:scripts/conveyor/pr-stack.mjs or we:scripts/lib/pr-merge-gate.mjs requires a named gates-unchanged test` (review approval, CI and proof-of-land for the new head; include closed-base rebase as well as restack). Document the same requirement in the card-authoring template in we:docs/agent/backlog-workflow.md; explicitly record a review-lens rationale for scope false positives.
  - `base move: a slice whose handling moves a child off its base names a test that takes the decision from the real classifyPr and passes it to the real planLabelDrain` (a slice card naming a rebase, retarget or `stackParents` change with only a preset `decision: 'merge'` candidate fails; one whose named test cites both functions and a control that keeps the old base passes).
- [A2] **Executable** — the following command includes `configuration contract: each matrix cell outside the safety floor changes outcome under an effective non-default override`. Parameterize every allowedBaseStates cell outside the independently tested safety floor, keeping all other inputs fixed. Include `configuration contract: floor-covered cells remain blocked under agent overrides` and `classification contract: every gate-read settings file is guard even with settings in lowRiskClasses`. Coordinate with slice 1 xcq5jb9, which owns this runtime test file; land that slice first so this card extends its contract instead of creating a competing evaluator.

  ```bash
  npm run test:unit -- scripts/lib/__tests__/stack-policy.test.mjs
  ```

- [A3] **Review lens** — amend the authoring checklist in we:docs/agent/backlog-workflow.md: every decision amendment and categorical exception has an explicit named child-test reference; every missing-setting test names the default and missing layer; every PR-head mutation preserves gates; every move of a child off its base clears every drain hold keyed on that base (the PR's `baseRefName` and its `stackParents` edge), proven through the real `classifyPr` and `planLabelDrain`. Where semantic prose exceeds the deterministic rules, a reviewer records the clause, test and assertion, or a concrete coverage gap. This is the fallback for A1's semantic checks, not a claim that keyword matching proves coverage.

## Non-goals

- [N1] Does not change stacking policy, implement its four slices, grant review approval, or run the human review ceremony.

## Edge cases this change must handle

1. **Untrusted text** — parse card prose and paths as data; never execute a named command or trust a card's claim of coverage without resolving the referenced test name.
2. **Truncated reads** — unreadable or incomplete cards, references or scope lists report an actionable incomplete-check result; never infer coverage from missing data.
3. **Shared state files** — read the card graph without changing cards or queue state; use fixture directories for test inputs.
4. **Fail closed** — unresolved mappings, missing test-file members and unordered overlaps fail the applicable check; unparseable semantic claims require the explicit review lens.
5. **Identity scoping** — resolve repo-qualified paths within their repository; same basenames in different repositories do not satisfy coverage or overlap.
6. **State over time** — recompute from current cards each run; stale clause mappings, parent counts or dependency cycles cannot reuse an earlier pass.
7. **Who wrote it** — author identity does not exempt a decision, epic or slice from the contract; quoted example prose does not create a real dependency edge.
