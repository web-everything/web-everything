---
bornAs: x6yigy0
kind: story
size: 3
parent: "4075"
status: resolved
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
dateOpened: "2026-10-02"
dateStarted: "2026-10-06"
dateResolved: "2026-10-06"
preparedDate: "2026-10-03"
preparedAgainstSha: "e2ca80ac2a75e42cb204b6d736bdf55bf87f5e38"
tags: []
---

# Prevention — Reject unfinished executable acceptance beside a mutation-proof claim

Filed mechanically on approval of chalbert/web-everything#3558. Make check:standards reject an open card that retains the scaffold's executable-command placeholder while claiming mutation proof in prose. A proof narrative must not disguise unfinished executable acceptance.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3558@6902fd5f86fc190cc6023186bfc7afe692ed4345

## Progress

- Original premise/scope: the approval cited `we:backlog/4752-health-responder-a-real-no-external-write-boundary-test.md:16` and scoped only that card, proposing rejection of “TODO: a command” beside prose mutation proof, or alternatively a scaffold argument.
- Corrected premise: that card now has preparation sections and concrete acceptance; its old line-16 citation no longer identifies the defect. Repairing it again would not deliver prevention. The placeholder is still emitted by `we:scripts/backlog/scaffold.mjs:113`; the original `we:scaffold.mjs` reference was incorrect. The scaffold option is unnecessary for the requested gate and would not catch manually authored cards.
- Source evidence: `lintBacklogItemRendering` in `we:scripts/check-standards-rules.mjs:1142` is the shared per-card lint. `we:scripts/check-standards.mjs:931` already forwards its errors to the standards gate. Existing content-lint tests live in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`. The separate `missingDoneWhenProof` audit in `we:scripts/audit-backlog-health.mjs:281` detects missing executable tokens but is advisory and does not implement this rejection.
- Observed baseline: a direct Node import and call of `lintBacklogItemRendering` with an open story, a prose “Mutation proof: remove the boundary and the test fails.” line, and the scaffold acceptance placeholder returned exactly `{"errors":[],"warnings":[]}`. The prevention is not already delivered.
- Corrected scope: implement the rule in `we:scripts/check-standards-rules.mjs` and cover it in the matching existing `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`. The main gate already consumes this interface; scaffold, health audit and the originally cited card are read-only evidence, not implementation deliverables.

## Design

Add a narrow hard-error check to `lintBacklogItemRendering`, retaining its existing input and `{ errors, warnings }` result shape. Fire only when all three conditions hold: the parsed item status is exactly open; its Done when section contains the literal scaffold marker “TODO: a command”; and an unfenced prose line in the body names “mutation proof” (case-insensitive, allowing a hyphen between the words).

Bound the acceptance scan from the level-two Done when heading to the next level-two heading or end of body, including subordinate headings. Recognize normal list and emphasis markup around the placeholder. Ignore fenced examples (both backtick and tilde fences) and inline-code-only mentions of mutation proof; a prose label with ordinary bold emphasis must still count. Do not treat the title or a section heading alone as a prose proof claim. Retain the literal placeholder match rather than attempting to decide whether arbitrary commands are executable.

Return one actionable error per offending item, identifying its ID and telling the author to replace the acceptance placeholder with a concrete command/test. Another real command elsewhere in the card does not cancel the unfinished criterion. Use the existing per-card error propagation so scoped and full standards checks share enforcement. Do not change status handling for any other lint.

This implements the requested rejection, without imposing a universal ban on newly scaffolded cards or expanding the advisory health audit into a hard gate. No new CLI argument, dependency or exported API is required; keep any scan helper private unless actual production reuse requires otherwise.

## MVP

1. **Must 1:** add the narrowly conditional hard error in `we:scripts/check-standards-rules.mjs`, preserving the existing lint return shape and all other diagnostics.
2. **Must 2:** add positive and negative fixture cases through the production lint entry point in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, including section boundaries, Markdown examples and all non-open statuses.
3. **Must 3:** demonstrate that bypassing this new error branch makes the named regression test fail, then restore the branch and pass the focused suite and standards gate.

## Test plan

Use the existing suite in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`. Run `node we:scripts/readiness/heavy-admission.mjs run -- vitest run we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` (remove the `we:` locus prefixes when executing from the WE root).

- Capability — RED today: an open story with the exact scaffold acceptance line and a separate prose mutation-proof claim returns one matching hard error, not merely a warning. Repeat with bold “Mutation proof”, hyphenated wording and a subordinate acceptance heading. A concrete command alongside the placeholder must not suppress the error.
- Preservation — GREEN today: active, preparing, parked and resolved versions of the same fixture have no new diagnostic. Mutation proof: remove the exact-open condition and these fixtures fail.
- Preservation — GREEN today: an open card with only the placeholder, only the prose claim, or a completed acceptance command has no new diagnostic. Mutation proof: weaken the conjunction or match all acceptance text and these fixtures fail.
- Preservation — GREEN today: a historical placeholder outside Done when, fenced examples using backticks or tildes, inline-code-only proof mentions, and a mutation-proof heading without a prose line do not trigger. Mutation proof: scan the whole raw body without section/prose filtering and these fixtures fail.
- Preservation — GREEN today: existing content-lint cases retain their expected diagnostics. Mutation proof: remove a pre-existing lint branch and its existing regression must fail. Run the full existing focused file, not just the new test name.

## Proof plan

1. Add the named positive test “rejects open mutation-proof cards with unfinished executable acceptance” through `lintBacklogItemRendering`. Run it against the unchanged rules and capture failure because the expected hard error is absent; the direct preparation probe already establishes this missing behavior, but is not a substitute for the new regression.
2. Implement the branch and run the entire focused suite green. Capture the offending fixture's diagnostic, including item ID and remediation, and a corrected fixture's lack of that diagnostic.
3. Temporarily bypass only the new error insertion. The named positive regression must turn red. Restore it and rerun the focused suite green; no mutation remains in the checkout.
4. Run `npm run check:standards` through its existing admission wrapper. Record actual results and distinguish unrelated failures from this rule's findings. If existing cards match, report their exact diagnostics rather than weakening the rule or silently expanding this item's edit scope. The probation runner owns preparation stamping and checks; these are implementation acceptance steps.

## Done when

- Musts 1 and 2: the focused command in Test plan passes, including the positive hard-error assertion and every preservation boundary in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`.
- Must 3: the named regression fails with the error branch bypassed and passes after restoration; the standards gate passes with the implemented rule enabled.

## Follow-ups

- A scaffold argument for prefilled acceptance remains optional future authoring convenience, not an alternative to this gate or a dependency of it.
- General command validation, rejection for other statuses, broader placeholder vocabulary and conversion of the health audit into enforcement are outside this narrow prevention.
- If the implementation's corpus check finds other offending cards, handle their acceptance repairs as explicitly scoped follow-up work; do not silently edit them as part of this two-file change.
