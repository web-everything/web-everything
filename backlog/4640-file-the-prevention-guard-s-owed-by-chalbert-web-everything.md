---
bornAs: xgjjvai
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs", "we:scripts/pr-land.mjs", "we:scripts/__tests__/pr-land.test.mjs", "we:scripts/lib/__tests__/review-escalation.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "46abe5d8e4fde88010e88f525ee7aa6a4e8f80fb"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3033's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/review-escalation.test.mjs:2976` — Extract the drain's verdict-decoration and pr-land's rubric-input assembly into pure functions, then test them by behaviour. A lint could also flag `readFileSync(...src).toContain(` wiring assertions.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3033@d80b906afed512c7b1403e09025b64d751ef9382

## Acceptance

[A1] Executable — add `4640 drain body propagation` in `we:scripts/__tests__/merge-ai-prs.test.mjs`: observe the real verdict builder's disclosure, null and empty-reason outputs. Dropping its deviation assignment must make this test fail; restoring it must pass.

[A2] Executable — add `4640 producer assembly` in `we:scripts/__tests__/pr-land.test.mjs`: import the proposed assembler, assert its complete scorer input, then score it. The test fails before extraction (missing export) and passes afterward. Cover raw-body disclosure, null versus empty diff text, scored/unscored basis, manifest coercion, current labels, cumulative counts and size admission. No defaults change: over/unknown size still requests review, and disclosure still takes precedence as human review.

[A3] Executable — add `4640 drain clearance chain` in `we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs`: build the verdict from a body, score it, pass through `drainGateInputs`, then call the real acceptance gate. Missing, stale and forged clearance park; trusted matching-head clearance merges; unreadable evidence defers with no label write. Removing either body propagation or the gate-input deviation mapping must fail the test and restoration must pass.

[A4] Executable — add `4640 producer caller` in `we:scripts/__tests__/pr-land.test.mjs`: invoke the production producer orchestration with stubbed forge/Git/label effects and real assembly/scoring, asserting a raw disclosure produces the human label and its reason. A clean small body keeps its existing label outcome. The pre-extraction implementation must fail the assertion that the production call traverses the exported assembly seam; after extraction, bypassing the seam or dropping the body must fail. Use a module spy or injected assembly dependency at the orchestration boundary, not source-text matching. Preserve roster inputs and current-label idempotence.

Run each named test through the queued focused commands in Test plan. These are planned executable regressions, not claims that the current suites are red. A1/A3's before/after proof is removal/restoration of the production propagation; A2/A4 also demonstrate the missing extraction before implementation.

## Progress

- Old premise: the prior preparation cited the source assertion at `we:scripts/lib/__tests__/review-escalation.test.mjs:2835`, drain builder at `we:scripts/merge-ai-prs.mjs:1584`, acceptance fixture at `we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs:606`, and producer assembly at `we:scripts/pr-land.mjs:1004`. Its six-file scope remains appropriate, but its proposed input object omitted a newer production input.
- Corrected evidence: the source assertion is at `we:scripts/lib/__tests__/review-escalation.test.mjs:2976`; `buildDrainVerdicts` starts at `we:scripts/merge-ai-prs.mjs:2392` and assigns deviation at `we:scripts/merge-ai-prs.mjs:2447`. The existing builder fixture at `we:scripts/__tests__/merge-ai-prs.test.mjs:317` only asserts graduation metadata. The clearance fixture at `we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs:685` supplies deviation manually.
- Partial delivery: `drainGateInputs` already exists at `we:scripts/merge-ai-prs.mjs:4780`; its deviation forwarding test is at `we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs:751`. The live call at `we:scripts/merge-ai-prs.mjs:6746` uses it. Reuse that boundary in the body-to-gate chain rather than invent another decorator.
- Producer assembly remains inline at `we:scripts/pr-land.mjs:1257`, with body parsing and `sizeAdmission` passed at `we:scripts/pr-land.mjs:1287`. The scorer at `we:scripts/pr-land.mjs:727` routes over/unknown admission to pending unless human review wins. Existing scorer tests at `we:scripts/__tests__/pr-land.test.mjs:70` start with assembled inputs. The prevention goal is therefore not already delivered.
- Corrected scope: keep the same six files, include size-admission passthrough and executable caller coverage, and preserve downstream roster fallback at `we:scripts/pr-land.mjs:1299`. Keep size 3: approximately 60 changed producer lines, 100 producer test lines, 40 builder test lines, 60 acceptance test lines, 15 shared test removals and at most 10 drain lines (about 285 changed lines). This is a story; no estimatedLoc field is added.
- Preparation used source inspection only. No implementation, test execution, policy change, dependency-edge change or preparation stamp is claimed; stamping and checks remain runner-owned.

## Design

Preserve the existing policy and extract only the producer's deterministic input assembly. Add an exported pure `buildProducerReviewInputs({ signals, manifest, currentLabels, body, sizeAdmission = null })` in `we:scripts/pr-land.mjs`, returning the complete argument object consumed by `resolveProducerReviewLabel`. Pass through changed files, own and cumulative line counts, human-basis files, nullable diff hunks and size admission unchanged. Preserve missing size admission as null; do not normalize unknown admission into a successful measurement. Preserve current finite-number coercion for dismissed findings, multi-repository detection, and `signals.scored ? signals.basisNarrowed !== false : true`. Parse deviation from the supplied raw body with the existing parser. Keep Git, forge reads, label writes and roster reconciliation outside the function. Route the production call through this function using the already-read values. Keep the assembled changed-files value available to the downstream roster fallback and current labels available to acceptance handling. Add an injected orchestration seam inside the existing producer module only if needed for A4; keep its default dependency the real assembler and all external effects stubbed in tests.

For the drain, test the existing `buildDrainVerdicts` boundary in `we:scripts/__tests__/merge-ai-prs.test.mjs` with in-memory PR listings and injected `readOf`. Feed its actual deviation output through `scoreEscalation` and `drainGateInputs` into `decideDrainReviewGate` using the acceptance fixture in `we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs`. Preserve the current distinction between body disclosure and independently trusted clearance evidence.

Replace the deviation wiring-source assertion in `we:scripts/lib/__tests__/review-escalation.test.mjs` with this behavioural coverage. Keep parser, score, forged-clearance and delivery-brief contract tests; the brief assertion tests an authored instruction, not executable wiring. Do not expand this item into a repository-wide source-assertion migration.

## MVP

1. Extend drain fixtures to observe parsed deviation from the real verdict builder, including absent disclosure and malformed/empty disclosure.
2. Extract producer input assembly and route the production scorer through it; add tests in `we:scripts/__tests__/pr-land.test.mjs` that assert the full assembled object and resulting review label, including size admission; exercise the production caller with injected effects (A4).
3. Exercise the produced drain deviation through the existing injected acceptance reader/gate fixture, then remove the superseded source-text assertion from `we:scripts/lib/__tests__/review-escalation.test.mjs`.
4. Deliver as one behavioural refactor with regression tests. No new runtime module, policy switch, network-dependent test or lint rule is required.

## Test plan

- `we:scripts/merge-ai-prs.mjs` → `we:scripts/__tests__/merge-ai-prs.test.mjs`: first-line disclosure survives verdict building; leading blanks are accepted; absent/later-line disclosure produces null; empty disclosure stays fail-closed; sanitised comment delimiters cannot become clearance evidence.
- `we:scripts/merge-ai-prs.mjs` → `we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs`: pass the verdict's deviation to the real gate composition; absent, stale and forged clearance park, while trusted matching-head clearance merges. Preserve unreadable-evidence deferral coverage.
- `we:scripts/pr-land.mjs` → `we:scripts/__tests__/pr-land.test.mjs`: assert all input fields, null diff hunks, scored/unscored basis handling, absent/malformed manifest metadata, numeric dismissed findings, cross-repository detection and current labels. Compose the assembler with the scorer: disclosure requires human review and retains its reason; a clean small fixture without disclosure retains its existing label.
- `we:scripts/lib/__tests__/review-escalation.test.mjs`: preserve existing parser/scorer/gate tests and remove only the superseded deviation executable-source assertion.
Run only the four scoped suites through the host heavy queue. Commands below use a shell function to resolve repository-prefixed references; all paths remain explicit about their repository. Run from the WE checkout:

```bash
we_path() { printf '%s' "${1#we:}"; }
node "$(we_path we:scripts/readiness/heavy-admission.mjs)" run -- npx vitest run "$(we_path we:scripts/__tests__/merge-ai-prs.test.mjs)" "$(we_path we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs)" "$(we_path we:scripts/__tests__/pr-land.test.mjs)" "$(we_path we:scripts/lib/__tests__/review-escalation.test.mjs)"
node "$(we_path we:scripts/readiness/heavy-admission.mjs)" run -- npm run check:standards
```

For red/green mutation evidence, use the same queued invocation with the matching file and `-t '4640'`. If admission is busy, wait once using the queue's supported wait option, then stop and report; do not poll. Full focused suites and standards must pass after restoration.

## Proof plan

Record the focused command's actual result during implementation. Demonstrate failure by temporarily dropping deviation assignment in `we:scripts/merge-ai-prs.mjs` and separately returning null deviation from the new producer assembler in `we:scripts/pr-land.mjs`; each matching behavioural test must fail, then pass after restoration. Also mutate one cumulative signal mapping to prove the full producer input assertion catches assembly drift. Keep mutations out of the delivered diff.

Use A4 to prove the production caller consumes the tested assembler with the real body, net-diff result and size admission. Separately mutate the caller to omit body or bypass assembly and record the failing test; do not substitute source inspection for this executable evidence. Also remove the deviation mapping in `drainGateInputs` to prove A3 reaches that hand-off. All tests use injected reads or pure inputs and require no live PR mutation.

## Follow-ups

The advisory's optional lint against executable-source string assertions is not required for this prevention guard. A broader lint would need to distinguish legitimate authored-text contracts from brittle executable wiring checks; leave that separate from this bounded behavioural refactor. No blocking design fork remains for the extraction and tests described here.
