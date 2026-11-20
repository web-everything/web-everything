---
bornAs: xwqr34z
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-core.mjs", "we:scripts/lib/__tests__/review-core.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "98e57b4c75e6202498fc613e547a5582240a5bae"
tags: []
---

# Prevention — When a card promises 'X still refuses' while reusing an existing predicate, require it to cite that pre… (from chalbert/web-everything#3450 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4767-keep-the-review-across-a-ci-heal-that-leaves-the-pr-own-chan.md (Design and Test plan)` — When a card promises 'X still refuses' while reusing an existing predicate, require it to cite that predicate's documented known gaps. A review-lens checklist item is enough; a script gate is not practical for this.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3450@8bb8192bba568e6215efbc0902e529619baf1df5

## Progress

Preparation checked the current source rather than treating the incident citation as the implementation target. The historical correction below is retained; this re-preparation also corrects the previous preparation’s stale source locations.

- **Old premise/scope:** the mechanically filed scope named only we:backlog/4767-keep-the-review-across-a-ci-heal-that-leaves-the-pr-own-chan.md, with a line-48 citation and an executable TODO. That card is now resolved and records implementation of the CI-heal carry. Its current Design and Test plan are the relevant historical promises; the old single-line citation does not identify the reusable prevention surface.
- **Corrected premise:** the missing work is a review checklist requiring a refusal promise to acknowledge the reused predicate's documented limitations. The existing claim-accuracy hunt brief at we:scripts/lib/review-core.mjs:1972-1995 covers factual prose and source resolution, but its six listed shapes do not require known-gap citations or an input-kind/error inventory. The generated mandate includes this brief at we:scripts/lib/review-core.mjs:1137-1139. The prevention is not already delivered by the resolved CI-heal implementation.
- **Source evidence:** the guarded caller invokes `acceptanceCoversHead` at we:scripts/review-set-label.mjs:1858. Its contribution escape is implemented at we:scripts/lib/review-escalation.mjs:2504-2521. The contribution normalizer explicitly documents dropped context/position information and shape-preserving relocation false honours at we:scripts/lib/review-escalation.mjs:1750-1799; the relocation cases in we:scripts/lib/__tests__/review-escalation.test.mjs:1783-1790 preserve that limitation. Reusing this predicate cannot establish an unqualified promise that every real contribution change refuses. This item requires honest qualification, not a new equivalence policy.
- **Corrected scope:** change we:scripts/lib/review-core.mjs and its existing matching suite we:scripts/lib/__tests__/review-core.test.mjs. The historical card, carry implementation and digest tests are research evidence, not edit targets. Keep the original goal: prevent unsupported refusal claims through a review-lens checklist, without adding a semantic script gate.

- **Re-preparation premise/scope:** the incoming card already scoped the two implementation/test files, but cited outdated caller, normalization and lens locations and had no labeled executable Acceptance. Current source still has only the six claim shapes at we:scripts/lib/review-core.mjs:1977-1986, so this prevention is not already delivered. Preserve that two-file scope; update citations and make the instruction-delivery guarantees executable.
- **Sizing evidence:** retain `size: 3`: approximately 20–30 changed lines for the expectation and brief in we:scripts/lib/review-core.mjs:1953-1995, plus 60–90 lines for focused regressions beside we:scripts/lib/__tests__/review-core.test.mjs:1819-1906. This remains one wording change with its matching suite, not runtime equivalence work. No dependency change is proposed.

## Design

Extend the existing claim-accuracy lens in we:scripts/lib/review-core.mjs:1953-1995. Add a concise requirement to `LENS_EXPECTATIONS` and an actionable checklist to `LENS_HUNT_BRIEF`, so the registered bar and generated review mandate agree.

For a card promising “X still refuses” (or equivalent) while reusing a predicate, require the reviewer to trace the actual caller and predicate, open its documented known gaps and relevant tests, and verify the card cites and qualifies applicable limitations. If documentation states no gaps, say what was inspected; absence of documentation is not proof of completeness. Report a concrete mismatch or missing required evidence, with source citations, rather than inventing a limitation.

For a card loosening a refusal, require two explicit Must lines in that card:

- **Must — errors:** identify unreadable/missing/error evidence and the refusal or existing guarded fallback it must trigger; a successful reused predicate alone is not proof of caller error handling.
- **Must — input kinds:** enumerate affected source, tests, documentation, configuration and data, including other applicable non-source inputs, and state which remain subject to refusal checks. Any exclusion needs evidence, not an assumption that non-code changes are harmless.

The checklist must distinguish a promised safeguard from a documented residual. In the motivating example, unchanged digest projection can still honour a shape-preserving relocation; the reviewer must require that qualification, not demand an unapproved digest-policy change. Retain the lens's existing requirement to resolve claims against source before reporting them. Do not change lens membership, blocking policy, or review dispatch.

The changed default is the instruction text supplied whenever claim-accuracy is selected. The existing `huntBriefForLens` → `buildPanelMandate` path at we:scripts/lib/review-core.mjs:1137-1139 delivers the checklist; `expectationForLens` at we:scripts/lib/review-core.mjs:2006-2010 supplies the registered expectation. No caller signature, persisted review state, roster membership or verdict policy changes. Test both public outputs explicitly. Unknown/unreadable/incomplete evidence must be described as unverified and reported as missing evidence, never inferred complete or promoted to a new runtime refusal policy.

## MVP

Ship only the expectation/checklist wording and regression coverage in the two scoped files. Use the existing claim-accuracy lens and mandate assembly; no new lens, parser, standards gate, runtime refusal logic or retrospective rewrite of the resolved incident card. The rule applies when the trigger claim occurs in prose already covered by the lens.

## Test plan

Extend we:scripts/lib/__tests__/review-core.test.mjs alongside its existing expectation and panel-mandate tests:

1. Assert the claim-accuracy expectation and hunt brief require a reused-predicate refusal claim to cite documented known gaps and qualify the promise.
2. Assert the emitted `buildPanelMandate` output for claim-accuracy contains the actionable error/fallback and input-kind Must requirements, including documentation, configuration and data. Check the generated output, not only the exported constant.
3. Assert the mandate asks for caller/predicate source and relevant tests, and distinguishes documented residuals from a demand to change policy. Keep existing source-grounding instructions intact.
4. Verify another lens does not receive the claim-accuracy-only hunt checklist; retain existing frozen-map, lookup and mandate tests.

Run the targeted suite through the host queue: invoke `node` with we:scripts/readiness/heavy-admission.mjs and arguments `run -- npx vitest run`, followed by the checkout-relative spelling of we:scripts/lib/__tests__/review-core.test.mjs. All named Acceptance tests below belong in that suite. Add the new assertions before the wording change and record their failure; after the change, the suite must pass. Removing the new checklist must make its mandate assertions fail again. These tests prove instruction delivery, not guaranteed model compliance.

## Proof plan

Record before/after targeted-suite output and the generated claim-accuracy mandate excerpt containing the new checklist. Inspect the rendered instruction as a whole to ensure both Must lines reach the reviewer and no contradictory blanket refusal guarantee was added.

Perform a source-grounded checklist replay against the motivating claim: trace we:scripts/review-set-label.mjs into we:scripts/lib/review-escalation.mjs, cite the documented relocation residual and the matching cases in we:scripts/lib/__tests__/review-escalation.test.mjs, then contrast an unqualified “every contribution change refuses” sentence with a version explicitly bounded by the digest's documented gaps. Record why the first fails the checklist and the second meets its citation requirement. Separately inspect examples missing the error Must line and omitting configuration/data from the input-kind Must line; both must be identified as incomplete. This is a manual rule replay, not a claim of live juror reliability.

During implementation, invoke `node` with we:scripts/readiness/heavy-admission.mjs and arguments `run -- npm run check:standards`; retain its actual result. If admission is busy, use the queue’s own bounded wait once, then stop and report if still busy. No forge mutation or live acceptance carry is needed for this checklist change.

## Follow-ups

- Closing the digest's relocation residual requires separate policy/design work; this item neither selects a mechanism nor expands the current carry guarantee.
- The broader already-handles claim-verification proposal in we:backlog/3280-review-lens-an-x-already-handles-this-claim-must-line-cite-t.md overlaps in source grounding but does not replace this specific known-gaps checklist. Avoid duplicating its broader correctness-lens work here.
- Model-compliance measurement can follow if observed reviews still miss this class; do not present wording-presence tests as proof that every future review catches it.

## Acceptance

These are new named Vitest cases to author in we:scripts/lib/__tests__/review-core.test.mjs. Run them through the queued targeted-suite command in Test plan. Each case must fail against the current wording, pass after the build, and fail again when its corresponding new instruction is removed; existing green lookup tests alone are insufficient.

- [A1] Executable: `4949 cites reused-predicate known gaps in expectation and mandate` asserts both `expectationForLens('claim-accuracy')` and `buildPanelMandate({ lens: 'claim-accuracy' })` require citation and qualification of documented known gaps. This covers the changed instruction default and both consumer outputs, with independent content assertions rather than equality to the same exported constant.
- [A2] Executable: `4949 requires caller predicate and residual evidence` asserts the generated mandate requires tracing the actual caller, predicate documentation and relevant tests, qualifying documented residuals without requiring a policy change, and retaining source resolution before reporting a finding.
- [A3] Executable: `4949 refuses to infer completeness from missing evidence` asserts the generated checklist explicitly treats unknown, unreadable or incomplete evidence as unverified, requires reporting missing evidence, and says absence of documented gaps does not prove completeness. This tests delivery of the fail-closed review instruction, not runtime acceptance behavior or model compliance.
- [A4] Executable: `4949 delivers both refusal-loosening Must lines` asserts generated output requires the errors line (missing/unreadable/error evidence plus refusal or existing guarded fallback) and the input-kinds line (source, tests, documentation, configuration, data and evidence for exclusions).
- [A5] Executable: `4949 scopes the new checklist to claim accuracy` first asserts the new checklist is present for claim-accuracy, then asserts its distinctive clauses are absent for every other panel lens. The positive arm makes this new case red before implementation; preserve existing roster, frozen-map, lookup and shared-mandate assertions.

The source-grounded replay and standards result described in Proof plan are supporting review evidence. Instruction-presence tests do not establish that every future reviewer obeys the checklist or that the digest residual is fixed.
