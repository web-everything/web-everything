---
bornAs: x4s0rw0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-core.mjs", "we:scripts/lib/__tests__/review-core.test.mjs", "we:docs/agent/reviewer-expectations.md", "we:scripts/lib/__tests__/build-safeguards.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-16"
preparedAgainstSha: "578083a15a2d401dab86a9a48f5c7fd3522e508c"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2947's independent review

Filed mechanically ON APPROVAL under the operator's 2026-09-27 rule. The originating review owed prevention for absolute promises in comments and universal claims in test descriptions. The historical proposals included a bare-word lint; the ruling below supersedes that option.

Current motivating examples: the best-effort cleanup guarantee at `we:scripts/operations/completion-store.mjs:248` and the “ANY writeCompletion call” claim at `we:scripts/operations/__tests__/completion-store.test.mjs:44`. These are evidence for the review practice, not the implementation touch set.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2947@4fbc20ca7ced68c23c28857df62a3ac6f25782ec

## Ruling (operator, 2026-10-09 ~13:25 ET)

The open choice from the prepare run (lint that requires a test citation for every absolute claim, vs a review
lens) is ruled **(b) review lens**: reviewers flag absolute guarantees in comments ("never", "always", "ANY")
and the author either cites the defending test or marks the claim `intentionally unguarded: <reason>`. No
`check:standards` lint on the bare words (too noisy: the words are common in plain prose, and a forced citation
invites rubber-stamping). Deciding whether prose is a real guarantee is judgment, so it lives in review. A narrow
lint on an explicit marker may follow later only if the lens misses cases. Same ruling applies to #4411.

## Progress

- Old premise/scope: implement prevention in `we:scripts/operations/completion-store.mjs` and `we:scripts/operations/__tests__/completion-store.test.mjs`, with historical source citations at lines 213–215 and test citations at 44–45; alternatives mixed lint and review guidance.
- Corrected premise: the cleanup comment now sits at `we:scripts/operations/completion-store.mjs:244`, and cleanup is best effort, so a claim of no temporary files after every possible call is too broad. The success test already exists at `we:scripts/operations/__tests__/completion-store.test.mjs:33`, alongside the rename-failure example at line 46 of that same file. Two examples do not establish all failure paths. This item delivers the ruled review practice, not new filesystem behavior.
- Existing partial delivery: `we:scripts/lib/review-core.mjs:223` defines `GUARANTEE_NEEDS_A_TEST_RULE`, already demanding defending tests and distinguishing tool-bearing from tool-free verification. `we:scripts/lib/review-core.mjs:343` includes it in the shared mandate; `we:scripts/lib/review-core.mjs:1121` composes that mandate into panel review. The rule lacks the ruled explicit unguarded disposition and success/failure guidance for universal test claims. Therefore this is not already done.
- Corrected scope: extend the existing shared rule and checklist, with matching tests. `we:docs/agent/reviewer-expectations.md:8` currently has only the general “Test each guarantee” instruction. `we:scripts/lib/build-policy.mjs:66` reads that checklist, and line 74 fences it for builders; no new loader or caller wiring is needed. Its output is already tested in `we:scripts/lib/__tests__/build-safeguards.test.mjs:26`.
- Caller/default evidence: `we:scripts/operations/review-pr.mjs:1578`, `we:scripts/review-core-cli.mjs:248`, and `we:scripts/converge-cli.mjs:282` call the shared panel builder. Extend the existing unconditional rule, without a new flag, seat, or setting. Existing public-preview mandate hashes at `we:scripts/lib/__tests__/review-core.test.mjs:598` must be deliberately refreshed after inspecting the intended wording delta.
- Size remains 3: approximately 20 changed lines in the shared rule, 65 in its tests, 10 in the checklist, and 25 in the checklist-output tests (about 120 changed lines across four files). No runtime changes or new lint engine are needed. No dependency changes proposed. Preparation does not stamp the card.

## Design

Extend `GUARANTEE_NEEDS_A_TEST_RULE` in `we:scripts/lib/review-core.mjs`, preserving the existing coverage-finding and tool-availability branches. Reviewers identify substantive guarantees expressed by “never”, “must never”, “always”, “ANY”, or “ALL”; plain prose containing those words is not automatically a defect. Require the author to cite a defending test (test file and case name) or explicitly mark `intentionally unguarded: <reason>`. A citation must be inspected for relevance, and an empty reason is not an explanation. The marker records acknowledged debt; it neither proves the guarantee nor overrides ordinary correctness/security dispositions.

For universal test comments, inspect actual inputs and assertions: require both success and failure examples where the claim spans both, and describe remaining limits honestly. A pair of examples alone is not universal proof. Use the completion-store example above to illustrate why best-effort cleanup needs narrower wording or acknowledged uncovered paths.

Add the same actionable practice to `we:docs/agent/reviewer-expectations.md`. Keep checklist delivery inside its existing untrusted-data fence. Missing/unreadable defending evidence is unknown coverage to report, never verified coverage; a tool-free reviewer names the required evidence and discloses inability to verify. This is review judgment, not a parser of arbitrary comments or a new admission gate.

## MVP

1. Extend the existing shared mandate rule with the citation/unguarded alternatives, universal-claim review procedure, and explicit unknown-evidence handling.
2. Add the checklist item with a success/failure example and the limits of example-based evidence.
3. Add focused mandate and rendered-checklist regressions in the scoped test files. Update existing mandate hashes only after reviewing the textual delta; retain existing assertions about review levels, tool availability, and fencing.

## Acceptance

- [A1] Executable — planned test `absolute guarantees require evidence or explicit reasoned debt` in `we:scripts/lib/__tests__/review-core.test.mjs` fails against today's rule and passes when the generated mandate contains the citation/marker alternatives, distinguishes substantive guarantees from bare words, and does not treat the marker as proof or automatic acceptance.
- [A2] Executable — planned test `universal test claims require success and failure evidence without claiming exhaustive proof` in `we:scripts/lib/__tests__/review-core.test.mjs` fails before the new review instruction and passes after it is present in generated mandates.
- [A3] Executable — planned test `absolute-claim guidance reaches default panel and tool-free review with unknown evidence reported` in `we:scripts/lib/__tests__/review-core.test.mjs` exercises the shared and panel builders, default and public-preview review levels, and tools/no-tools wording. It fails before the explicit missing/unreadable-evidence instruction and passes after; it also preserves the existing no-fabricated-verification instruction. This covers the changed default mandate consumed by existing callers and its fail-closed evidence guidance.
- [A4] Executable — planned test `rendered reviewer checklist carries absolute-claim guidance inside its data fence` in `we:scripts/lib/__tests__/build-safeguards.test.mjs` reads the real checklist and calls `renderBuildRequirements` with checklist delivery enabled. It fails before the checklist addition and passes after, asserting the citation/marker and success/failure instructions occur between the existing fence boundaries.

## Test plan

Add the four named regressions first. These test delivery of review instructions, not an LLM's ability to classify every comment. Exercise actual builder output rather than checking only an exported constant. Preserve the existing injection/fencing tests and unknown-lens rejection. Review existing public-preview hashes explicitly when the shared mandate changes.

Run only the two scoped test files through the host heavy queue. For an executable command with repository-qualified references, set `q=we:scripts/readiness/heavy-admission.mjs`, `a=we:scripts/lib/__tests__/review-core.test.mjs`, and `b=we:scripts/lib/__tests__/build-safeguards.test.mjs`, then run `node "${q#we:}" run -- npx vitest run "${a#we:}" "${b#we:}"`. The shell strips the repository prefix for local execution. If busy, use the queue's supported bounded wait once and report if it remains unavailable.

## Proof plan

Capture the four new tests failing against the pre-build mandate/checklist, then passing after implementation. Record names, command, and observed output. Inspect generated mandates for default and public-preview review levels and the rendered fenced checklist. Confirm the shared caller paths listed in Progress still compose the updated rule; no caller-specific prompt copies are introduced. Do not describe prompt-content assertions as proof of reviewer judgment accuracy. The runner owns preparation checks and stamping; implementation validation includes the queued standards gate.

## Follow-ups

Coordinate the same ruled practice with #4411 to avoid duplicate guidance; no dependency edge is required by the current evidence. A narrow explicit-marker lint remains a later option only if observed lens misses justify it, per the operator ruling. Completion-store comment narrowing or additional cleanup-failure tests can be separate implementation work; they are not substitutes for this shared prevention guard.
