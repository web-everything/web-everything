---
bornAs: xyusi8m
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules*.test.mjs", "we:scripts/__tests__/check-standards-frontmatter-parse.test.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/__tests__/check-standards-backlog-schema.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-08"
preparedAgainstSha: "873a1869f903e11c1581cb21e74d0619136c7adb"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2871's independent review

Close the frontmatter-prevention debt recorded on approval of #2871: require points on childless epics and reject obsolete classification fields using the current canonical `kind` schema. Extend the existing standards validators and add regression coverage; the two reviewed cards are provenance, not the implementation scope.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2871@4fc1a8ca300c9f3e20d92ae2ed704339ef026ff2

## Progress

- Prepare-validation repair: the previous scope included the frontmatter regression home but omitted the required matching rules-test pattern. Added we:scripts/__tests__/check-standards-rules*.test.mjs; the existing we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs:7 imports the validator, and :34 covers kind/size behavior. The implementation goal and size 3 remain unchanged.
- Original premise: the approval requested a missing-size guard for childless epics and a validator requiring `workItem` while rejecting `kind`. Original scope contained only we:backlog/4376-delivery-policy-as-configurable-dimensions-product-shape.md and we:backlog/4375-capture-github-cost-headers-on-the-daemons-own-gh-calls.md; their cited lines 1 and 2 identify frontmatter, not validator implementation.
- Corrected premise: `kind` is canonical, so the second guard must require `kind` and reject retired `workItem`, not reverse the migration. Evidence: we:scripts/backlog/migrate-kind.mjs:5 documents the conversion; we:scripts/check-standards-rules.mjs:375 already requires `kind`, and :386 validates its enum. The current classification requirement is therefore partly delivered, not an outstanding schema replacement.
- Remaining sizing gap: we:scripts/check-standards-rules.mjs:454 validates Fibonacci values and requires story sizes, but does not require a childless epic's size. The settled two-state rule is in we:docs/agent/backlog-workflow.md:178; any child, including a task, makes an epic sliced. The collection context already exposes parent edges at we:scripts/check-standards.mjs:848. Determine children from those edges, never prose or an invented child-list field.
- Corrected scope: the two validator source files and their matching tests listed in frontmatter. Existing pure regression home: we:scripts/__tests__/check-standards-frontmatter-parse.test.mjs:24. Planned gate integration home: we:scripts/__tests__/check-standards-backlog-schema.test.mjs. Raw YAML is already available in the standards gate at we:scripts/check-standards.mjs:1039, allowing obsolete-field checks before loader normalization can hide them.
- Size retained at 3: bounded validation, gate wiring, and fixture coverage at the seams above. No schema-policy reversal, corpus point estimation, or runtime changes are part of this item. Preparation is source inspection; no implementation or test result is claimed.

## Design

Extend the existing pure validation surface in we:scripts/check-standards-rules.mjs, rather than introducing a second YAML parser or a general schema framework. Keep the existing required-`kind` and enum checks. Add a raw-frontmatter check that rejects an authored `workItem` key even alongside a valid `kind`; use own-key presence so empty/null values cannot evade detection. Run it over successfully parsed YAML in we:scripts/check-standards.mjs. Preserve existing malformed-YAML diagnostics.

For an epic, derive child existence from the complete collection's `parent` edges, normalizing IDs to strings. Require an existing allowed Fibonacci size when there are no children. Enforce the complementary documented rule that an epic with any child has no size. Do not infer children from narrative promises, count only open children, or exempt resolved children. Leave other kinds' sizing rules intact. Diagnostics identify the card and offending field and explain the structural correction; they must not choose a point estimate for an author.

## MVP

1. **Must 1:** The standards gate rejects a childless epic without size and a sliced epic with size, while accepting the corresponding correctly sized/unsized shapes.
2. **Must 2:** The standards gate requires the current canonical classification and rejects authored `workItem`, including when valid `kind` coexists. Existing valid kinds and malformed-YAML handling retain their behavior.
3. **Must 3:** Pure fixtures and an actual gate integration regression cover both guards, with named diagnostics and failing exit status. No production backlog cards are mutated by tests.

## Test plan

- Extend the matching rules suite under we:scripts/__tests__/check-standards-rules*.test.mjs for kind/size regressions, including we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs; retain its existing investigation-without-size acceptance case.
- Extend we:scripts/__tests__/check-standards-frontmatter-parse.test.mjs for the rules source: childless epic missing/valid/non-Fibonacci size; sized and unsized epics with story or task children; resolved children still counted; numeric/string parent IDs; unrelated parents; unchanged story/task/decision/feature/investigation behavior.
- In the same existing test file cover missing/invalid/valid `kind`, legacy-only `workItem`, both fields, and null/empty legacy values. Keep malformed-YAML cases passing.
- Add we:scripts/__tests__/check-standards-backlog-schema.test.mjs for we:scripts/check-standards.mjs: run the real gate in a disposable fixture checkout, verify invalid fixtures produce the specific diagnostic and nonzero exit, then correct only the offending fields and verify those diagnostics disappear. Isolate unrelated baseline failures; a nonzero exit alone is not evidence of this guard.
- Run focused Vitest files and `npm run check:standards` only through the host heavy-run queue, via we:scripts/readiness/heavy-admission.mjs. The runner owns preparation-time checks; these are implementation acceptance checks.

## Proof plan

Record red/green output for each new regression: run the added tests against the pre-change validator/gate, then the implementation. Temporarily remove each new guard independently in a disposable checkout and demonstrate that its matching test fails; restoring it must pass. For the gate integration, retain the fixture frontmatter, exit code, and named diagnostic before/after correction. Run the full standards gate through the heavy queue and report any pre-existing corpus violations separately, without assigning arbitrary sizes or broadening this card into backlog cleanup.

## Done when

1. **Executable — Must 1 and Must 2:** The queued focused suite exercises the invalid and valid shapes in the Test plan, and the real gate emits the expected diagnostics for invalid fixtures.
2. **Executable — Must 3:** The queued integration regression and independent guard-removal checks prove both guards are wired into the gate; the full standards check result is recorded with any unrelated baseline failures explicitly identified.

## Follow-ups

- If the full-corpus run reveals unsized childless epics, report their IDs for author sizing or slicing in a separate cleanup item; this preparation does not choose their estimates or alter the two historical review cards.
- Broader schema-framework adoption and scoped-linter parity are separate work. This item's acceptance remains the approval's standards-gate prevention debt, translated to the current schema.
