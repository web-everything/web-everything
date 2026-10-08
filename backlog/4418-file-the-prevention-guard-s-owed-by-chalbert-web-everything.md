---
bornAs: xcom9j2
kind: story
size: 3
parent: "4075"
status: resolved
scope: ["we:scripts/lib/review-core.mjs", "we:scripts/lib/__tests__/review-core.test.mjs"]
dateOpened: "2026-09-28"
dateStarted: "2026-10-07"
dateResolved: "2026-10-07"
preparedDate: "2026-10-07"
preparedAgainstSha: "3a6d151dba45e0eaad8fdf70d3d590c203fd5a3a"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2837's independent review

Complete the remaining Risks-to-Test-plan review guard from the approval's prevention debt. The original prefix ban and mandatory `workItem` proposals contradict the current repository vocabulary; retain the prevention goal using the existing review mandate and current validation rules.

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval"). None of the original prevention suggestions blocked approval.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2837@012435fdb39b14ce718cdb5b5b8461e656d3c529

## Progress

Premise checked against the current checkout during probation preparation:

- **Old premise/scope:** edit only we:backlog/4340-wip-shows-the-daemons-and-what-they-are-really-doing.md; add a gate banning `plateau:` as abandoned, require `workItem` through a new JSON schema validator, and require Risks constraints to map to named executable tests. The original citations to lines 5, 2 and 40 did not identify implementation seams.
- **Corrected prefix premise:** `plateau:` means the live plateau-app repository, explicitly defined in we:docs/agent/conventions.md:73–77. The scope gate accepts that alias at we:scripts/check-standards.mjs:1015. The originating card is now resolved, with a plateau-app PR graduation and that valid scope at we:backlog/4340-wip-shows-the-daemons-and-what-they-are-really-doing.md:5–10. Banning the alias would reject valid work; do not implement that suggestion or rewrite the resolved card.
- **Corrected metadata premise:** `kind` replaced `workItem` (we:scripts/check-standards-rules.mjs:223–226). Required-field and enum validation already exists at we:scripts/check-standards-rules.mjs:374–386 and is invoked by the gate at we:scripts/check-standards.mjs:851. Missing-kind regression coverage exists at we:scripts/__tests__/check-standards-frontmatter-parse.test.mjs:23–35, delivered in commit a51aeb9e2. No new schema engine or resurrected field is needed.
- **Remaining gap:** the current risk text is at we:backlog/4340-wip-shows-the-daemons-and-what-they-are-really-doing.md:44–46, with the original test plan at we:backlog/4340-wip-shows-the-daemons-and-what-they-are-really-doing.md:48–50. It states bounded log reads and isolated degradation, while the short test plan names degradation but no bounded-read assertion. This is the historical example, not a claim that the resolved implementation lacks tests. The existing `GUARANTEE_NEEDS_A_TEST_RULE` in we:scripts/lib/review-core.mjs:219–230 demands tests for prose guarantees, but does not explicitly require the named mapping between Risks and Test plan. Its transport tests at we:scripts/lib/__tests__/review-core.test.mjs:2509–2565 likewise do not pin that mapping.
- **Corrected scope:** extend the existing guarantee rule in we:scripts/lib/review-core.mjs and its matching test file we:scripts/lib/__tests__/review-core.test.mjs. No changes to the originating card, backlog schema, alias vocabulary or dispatcher. Size stays **3**: one shared mandate extension, transport regression coverage and a review behavior probe; the two speculative gate implementations drop out.

## Design

Extend `GUARANTEE_NEEDS_A_TEST_RULE` in we:scripts/lib/review-core.mjs with the specific remaining obligation: when the supplied review material contains a backlog card's Risks and Test plan, enumerate each explicit behavioral constraint in Risks and identify the matching Test plan entry, repository-qualified test file, named test case and observable assertion. Accept both heading and bold-label section forms, since the originating card uses bold labels.

A generic "unit-test the reader" does not establish that bounded I/O is tested. For a bounded-read constraint, the mapping must identify an assertion on bytes read or the read range, not merely a successful parse. For isolated degradation, identify an assertion that unrelated snapshot fields remain available after a reader failure. Treat an absent mapping as a coverage finding under the existing disposition rules. For preparation review, distinguish a concrete planned test from a test already implemented; for implementation review, inspect the actual test when available.

Reuse the existing tool-bearing and tool-free branches: reviewers with tools verify the test and, where permitted, mutation-probe the guard; tool-free reviewers explicitly label their assessment unverified. If the source card or sections are absent from the supplied material, report that limitation rather than inventing missing coverage. Do not expand review input acquisition or change acceptance severity policy.

The extension rides `buildMandate` through its existing inclusion of the guarantee rule at we:scripts/lib/review-core.mjs:325. Do not create a parallel lens, new parser or heuristic standards lint for semantic correspondence. The original debt expressly permits a review lens; specializing the existing coverage instruction requires no new policy choice.

## MVP

- One shared mandate addition requiring Risks-to-Test-plan traceability, including test file, case and asserted constraint.
- Preserve coverage disposition, preparation-versus-implementation honesty, and tool-free verification limits.
- Pin the instruction across base, panel, validator and PR-diff adapter outputs using we:scripts/lib/__tests__/review-core.test.mjs.
- Exclude the invalid prefix ban and obsolete `workItem` requirement based on the evidence above. Existing metadata validation remains the guard for that class of defect.

## Test plan

Extend we:scripts/lib/__tests__/review-core.test.mjs alongside its existing guarantee-rule suite:

1. **`requires Risks constraints to map to named Test plan cases`** — independently assert that the rule demands enumeration, test file, case and observable assertion; a generic reference to testing must not satisfy the expectation. This test must fail before the mandate extension.
2. **`carries risk traceability through every PR review transport`** — assert the new semantic requirements in base, panel, validator and PR-diff adapter output, following the existing four-transport table. Test the new content, not only inclusion of a constant that could itself omit it.
3. **`keeps planned tests and unavailable evidence distinct from verification`** — pin the preparation/implementation distinction, absent-input limitation and tool-free honesty. Retain existing tests for coverage framing and single inclusion.

Run the affected file through the host heavy-run queue only: use the `run -- npx vitest run` mode of we:scripts/readiness/heavy-admission.mjs with we:scripts/lib/__tests__/review-core.test.mjs (strip the display-only `we:` prefix when passing paths to Node/Vitest). Run `npm run check:standards` through the same queue. No unit test result alone establishes that a reviewer follows the instruction.

## Proof plan

For the implementation PR, capture the new focused test failing against the pre-change mandate and passing with the extension; then capture the full affected test-file result and queued standards gate result.

Exercise the generated mandate with paired synthetic review inputs, keeping both sections in the supplied material: (A) Risks requires bounded log reads and isolated degradation, while Test plan covers only parsing/degradation; (B) the same input with an explicit test file, named case and read-range assertion added. Include one bold-label variant and one heading variant. A reviewer must identify the unmapped bounded-read constraint in A and recognize its mapping in B without claiming an execution or mutation it did not perform. Keep fixture paths repository-qualified and label invented test cases as planned.

Record the input, generated mandate and reviewer output as PR evidence. Run the probe during implementation review, not as a self-issued acceptance verdict in this preparation turn. If reviewer behavior fails despite green transport tests, revise the instruction and repeat the paired probe before declaring delivery.

## Follow-ups

- A deterministic semantic-mapping gate would need a separately justified structured constraint/test representation; do not infer coverage from keyword overlap in this item.
- Any evidence of actual abandoned-prototype targeting should be investigated by resolved repository/path identity, not by banning the sanctioned `plateau:` alias. No such new guard is established by this card's original citation.

## Done when

1. The focused traceability regression fails before and passes after the shared mandate change; all affected transport tests and the standards gate pass through host heavy admission.
2. Paired review evidence demonstrates detection of the missing bounded-read test mapping and recognition of the concrete planned mapping, with truthful verification limits.
3. The implementation accounts for all three original suggestions: the surviving review guard is delivered, the prefix premise is corrected, and the current required-field guard is cited rather than duplicated.
