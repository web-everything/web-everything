---
bornAs: xwqr34z
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-core.mjs", "we:scripts/lib/__tests__/review-core.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "0d47fafa69922b3bc2fb00f0c30162c56d981088"
tags: []
---

# Prevention — When a card promises 'X still refuses' while reusing an existing predicate, require it to cite that pre… (from chalbert/web-everything#3450 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4767-keep-the-review-across-a-ci-heal-that-leaves-the-pr-own-chan.md (Design and Test plan)` — When a card promises 'X still refuses' while reusing an existing predicate, require it to cite that predicate's documented known gaps. A review-lens checklist item is enough; a script gate is not practical for this.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3450@8bb8192bba568e6215efbc0902e529619baf1df5

## Progress

Preparation checked the current source rather than treating the incident citation as the implementation target.

- **Old premise/scope:** the mechanically filed scope named only we:backlog/4767-keep-the-review-across-a-ci-heal-that-leaves-the-pr-own-chan.md, with a line-48 citation and an executable TODO. That card is now resolved and records implementation of the CI-heal carry. Its current Design and Test plan are the relevant historical promises; the old single-line citation does not identify the reusable prevention surface.
- **Corrected premise:** the missing work is a review checklist requiring a refusal promise to acknowledge the reused predicate's documented limitations. The existing claim-accuracy hunt brief at we:scripts/lib/review-core.mjs:1972-1995 covers factual prose and source resolution, but its six listed shapes do not require known-gap citations or an input-kind/error inventory. The generated mandate includes this brief at we:scripts/lib/review-core.mjs:1137-1138. The prevention is not already delivered by the resolved CI-heal implementation.
- **Source evidence:** the guarded caller invokes `acceptanceCoversHead` at we:scripts/review-set-label.mjs:1858-1862. Its contribution escape is implemented at we:scripts/lib/review-escalation.mjs:2509-2522. The contribution normalizer explicitly documents dropped context/position information and shape-preserving relocation false honours at we:scripts/lib/review-escalation.mjs:1720-1773; the relocation cases in we:scripts/lib/__tests__/review-escalation.test.mjs:1780-1808 preserve that limitation. Reusing this predicate cannot establish an unqualified promise that every real contribution change refuses. This item requires honest qualification, not a new equivalence policy.
- **Corrected scope:** change we:scripts/lib/review-core.mjs and its existing matching suite we:scripts/lib/__tests__/review-core.test.mjs. The historical card, carry implementation and digest tests are research evidence, not edit targets. Keep the original goal: prevent unsupported refusal claims through a review-lens checklist, without adding a semantic script gate.

- **Current re-preparation:** the incoming card already scoped the correct two files, but its implementation line citations had drifted. The refreshed citations above identify the current guarded caller, digest residual and mandate wiring. The expectation at we:scripts/lib/review-core.mjs:1956 and the six-shape brief still lack this rule; existing tests at we:scripts/lib/__tests__/review-core.test.mjs:1819-1893 cover registration and transport, not this checklist's content. Thus the goal remains undelivered, with no scope expansion or unresolved policy fork.
- **Sizing:** retain size 3. Estimate approximately 20 changed instruction lines in we:scripts/lib/review-core.mjs:1956 and :1972 plus 60–90 test lines alongside we:scripts/lib/__tests__/review-core.test.mjs:1845. Two existing surfaces, no new transport or runtime branch. No estimatedLoc is added to this story. Preparation stamps are left for the runner.

## Design

Extend the existing claim-accuracy lens in we:scripts/lib/review-core.mjs. Add a concise requirement to `LENS_EXPECTATIONS` and an actionable checklist to `LENS_HUNT_BRIEF`, so the registered bar and generated review mandate agree.

For a card promising “X still refuses” (or equivalent) while reusing a predicate, require the reviewer to trace the actual caller and predicate, open its documented known gaps and relevant tests, and verify the card cites and qualifies applicable limitations. If documentation states no gaps, say what was inspected; absence of documentation is not proof of completeness. Missing, unreadable or incomplete supporting evidence must be reported as unverified with the missing source identified; do not certify the refusal promise or infer a new runtime refusal policy. Report a concrete mismatch or missing required evidence, with source citations, rather than inventing a limitation.

For a card loosening a refusal, require two explicit Must lines in that card:

- **Must — errors:** identify unreadable/missing/error evidence and the refusal or existing guarded fallback it must trigger; a successful reused predicate alone is not proof of caller error handling.
- **Must — input kinds:** enumerate affected source, tests, documentation, configuration and data, including other applicable non-source inputs, and state which remain subject to refusal checks. Any exclusion needs evidence, not an assumption that non-code changes are harmless.

The checklist must distinguish a promised safeguard from a documented residual. In the motivating example, unchanged digest projection can still honour a shape-preserving relocation; the reviewer must require that qualification, not demand an unapproved digest-policy change. Retain the lens's existing requirement to resolve claims against source before reporting them. Do not change lens membership, blocking policy, or review dispatch. Defaults remain unchanged. The existing caller buildPanelMandate receives the checklist through huntBriefForLens; expectationForLens supplies the updated expectation to charter consumers. Exercise both public outputs without changing their signatures or persisted roster state.

## MVP

Ship only the expectation/checklist wording and regression coverage in the two scoped files. Use the existing claim-accuracy lens and mandate assembly; no new lens, parser, standards gate, runtime refusal logic or retrospective rewrite of the resolved incident card. The rule applies when the trigger claim occurs in prose already covered by the lens.

## Test plan

Extend we:scripts/lib/__tests__/review-core.test.mjs alongside its existing expectation and panel-mandate tests:

1. Assert the claim-accuracy expectation and hunt brief require a reused-predicate refusal claim to cite documented known gaps and qualify the promise.
2. Assert the emitted `buildPanelMandate` output for claim-accuracy contains the actionable error/fallback and input-kind Must requirements, including documentation, configuration and data. Check the generated output, not only the exported constant.
3. Assert the mandate asks for caller/predicate source and relevant tests, and distinguishes documented residuals from a demand to change policy. Keep existing source-grounding instructions intact.
4. Verify another lens does not receive the claim-accuracy-only hunt checklist; retain existing frozen-map, lookup and mandate tests.

Run the targeted suite using Vitest with we:scripts/lib/__tests__/review-core.test.mjs as the path argument. Add the new assertions before the wording change and record their failure; after the change, the suite must pass. Removing the new checklist must make its mandate assertions fail again. These tests prove instruction delivery, not guaranteed model compliance.

## Proof plan

Record before/after targeted-suite output and the generated claim-accuracy mandate excerpt containing the new checklist. Inspect the rendered instruction as a whole to ensure both Must lines reach the reviewer and no contradictory blanket refusal guarantee was added.

Perform a source-grounded checklist replay against the motivating claim: trace we:scripts/review-set-label.mjs into we:scripts/lib/review-escalation.mjs, cite the documented relocation residual and the matching cases in we:scripts/lib/__tests__/review-escalation.test.mjs, then contrast an unqualified “every contribution change refuses” sentence with a version explicitly bounded by the digest's documented gaps. Record why the first fails the checklist and the second meets its citation requirement. Separately inspect examples missing the error Must line and omitting configuration/data from the input-kind Must line; both must be identified as incomplete. This is a manual rule replay, not a claim of live juror reliability.

Run `npm run check:standards` through the host heavy-run queue during implementation and retain its actual result. No forge mutation or live acceptance carry is needed for this checklist change.

## Follow-ups

- Closing the digest's relocation residual requires separate policy/design work; this item neither selects a mechanism nor expands the current carry guarantee.
- The broader already-handles claim-verification proposal in we:backlog/3280-review-lens-an-x-already-handles-this-claim-must-line-cite-t.md overlaps in source grounding but does not replace this specific known-gaps checklist. Avoid duplicating its broader correctness-lens work here.
- Model-compliance measurement can follow if observed reviews still miss this class; do not present wording-presence tests as proof that every future review catches it.

## Acceptance

All named tests below are proposed additions to we:scripts/lib/__tests__/review-core.test.mjs. Each must fail against the current wording and pass after implementation; assertions must inspect required content independently rather than compare an output only to the same exported string. These guarantees concern delivered reviewer instructions, not deterministic reviewer behavior.

- [A1] Executable: test `4949 requires known-gap citations in expectation and mandate` asserts that expectationForLens and buildPanelMandate both require a reused-predicate refusal claim to cite documented known gaps and qualify its promise. Include the equivalent-claim trigger, caller/predicate tracing and relevant-test evidence in the mandate assertions.
- [A2] Executable: test `4949 leaves unsupported refusal claims unverified` asserts the emitted mandate requires missing, unreadable or incomplete evidence to be reported with the missing source, never certified from silence. Assert the instruction to retain source resolution and distinguish a documented residual from a demand to change policy.
- [A3] Executable: test `4949 inventories errors and all affected input kinds` asserts the emitted mandate requires both Must lines for a loosened refusal: error/refusal or existing guarded fallback, and source, tests, documentation, configuration, data and other applicable inputs with evidence for exclusions. Missing either requirement must fail this test.
- [A4] Executable: test `4949 delivers checklist only through claim-accuracy with defaults intact` asserts the new checklist reaches the default claim-accuracy buildPanelMandate call and expectationForLens, remains present with explicit normal context options, and is absent from other lenses. Include a positive new-content assertion so this test fails before implementation; retain existing unknown-lens rejection, frozen-map, roster and shared-rule tests as regression checks. No runtime default, caller signature, dispatch or stored-state migration is required.

Run these tests and the existing scoped suite through `node` with we:scripts/readiness/heavy-admission.mjs, arguments `run --wait-ms=60000 -- npx vitest run` followed by the checkout-relative form of we:scripts/lib/__tests__/review-core.test.mjs (strip only the repository prefix when supplying filesystem arguments). Use the same queue for `npm run check:standards`. If capacity is unavailable, use that single bounded wait and report the blocker; do not poll. During build, record red/green output and the checklist-removal mutation result, then restore the implementation. The manual replay in Proof plan supplements these executable delivery checks; it does not substitute for them.
