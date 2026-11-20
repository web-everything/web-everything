---
bornAs: xwi23yt
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/prep-review.mjs", "we:scripts/conveyor/__tests__/prep-review.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "c5048aa20e1c76289b25f51c126d31dad17346ea"
tags: []
---

# Prevention — A semantic spec checker that flags when a "Preservation" requirement (retain existing strict validation… (from chalbert/web-everything#3379 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4057-wip-fleet-panel-pr-ownership-rows-and-a-why-is-nothing-dispa.md:69` — A semantic spec checker that flags when a "Preservation" requirement (retain existing strict validation) explicitly conflicts with a "Design" requirement (replace with dynamic names) in the same document.
2. `we:backlog/4057-wip-fleet-panel-pr-ownership-rows-and-a-why-is-nothing-dispa.md:39` — An AI review gate that cross-references all specific behavioral requirements ("must", "never", "separately") in the Design section against the assertions listed in the Test plan section.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3379@2e471c42f5e288a27a3e327a7d817b2b2e4ff9df

## Progress

- Original premise/scope: change only the motivating Fleet card and add a semantic checker plus an AI requirement-to-test gate. Corrected scope: extend the existing preparation PR review in we:scripts/conveyor/prep-review.mjs and its matching tests in we:scripts/conveyor/__tests__/prep-review.test.mjs. The Fleet card is regression evidence, not an implementation target.
- The original approval-time citations were :49 and :46; the citations above now point to current locations. Current evidence is we:backlog/4057-wip-fleet-panel-pr-ownership-rows-and-a-why-is-nothing-dispa.md:39 (separate Build/PR explanations), :40 (replace fixed runner names), and :69 (preserve four-runner validation). Retaining acceptance of old four-runner payloads is compatible with dynamic names; retaining an exactly-four/closed-name rejection rule is not. The checker must distinguish those meanings rather than flag every mention of preservation as contradictory.
- The existing model mandate explicitly excludes design review (we:scripts/conveyor/prep-review.mjs:180). Its reader only retains seven edge-case IDs (:232–237); its summary claims those checks, not semantic coverage (:251–253). This is not already delivered by that gate. The separate full-card operation has a general risk mandate at we:scripts/operations/review-prep.mjs:266–316; it does not supply this conveyor pass's explicit requirement/assertion evidence.
- Current callers already pass a caller-provided schema through the injected judge: we:scripts/conveyor/prep-review-io.mjs:68–69 and we:scripts/conveyor/prep-review.mjs:409. Extend that schema at this call, without changing the shared worker-result contract. Review planning retains the advisory default and one blocking round (:27–40, :335). Same-head persisted notes currently skip the model (:405–406); migration must avoid treating old notes as proof of the new checks.
- Size remains **3**: approximately 150 changed lines in we:scripts/conveyor/prep-review.mjs for mandate/schema/evidence validation/result integration and versioned replay, plus 220 lines in we:scripts/conveyor/__tests__/prep-review.test.mjs for paired semantic fixtures, negative paths and caller/replay cases. This is a two-file extension of an existing review, not a new model service or whole-repository scanner. No estimatedLoc is added to this story.

## Design

Extend the existing single model pass with two explicit semantic checks: Preservation versus Design consistency, and Design behavioral requirements versus Test plan assertions. Keep the seven edge-case checks. Do not implement synonym matching as proof of semantic equivalence.

Use a local judge response envelope containing the existing worker result and a required semantic evidence object; validate both before reduction. Include a completion flag, preservation/design comparisons, and a requirement coverage table. Each row cites exact quoted text and section-relative line locations in the supplied card. Requirement rows enumerate concrete Design obligations, including “must”, “never”, “separately”, changed defaults, callers and error handling, with matching assertion citations or an explicit uncovered result. The model must also find imperative requirements without those keywords. A missing Preservation section is explicitly not applicable; a missing Design or Test plan is incomplete, never implicitly clean.

Comparison outcomes distinguish conflict, compatible and ambiguous. Require both sides and a short explanation for conflict; compatible legacy-input acceptance must not be treated as preservation of an obsolete closed enum. Ambiguity becomes a request to clarify the card, not an invented policy choice. Coverage requires an asserted observable result, not merely a test filename or the presence of a keyword. Validate cited text against the input and reject malformed, invented, out-of-range or missing citations. Semantic judgment remains model-derived: structural validation cannot prove that the model found every implicit obligation.

Reduce valid conflict/ambiguity and uncovered rows into stable local finding IDs `preservation-design-conflict` and `requirement-test-gap`. Preserve multiple cited obligations in the evidence rather than silently collapsing them by category; keep the final worker-result bounded and schema-compatible. Incomplete evidence produces `semantic-review-incomplete`, an operator-visible request for full manual review or rerun. Unknown finding IDs, contradictory clean/result rows, malformed answers, judge failure and input exceeding the existing 60,000-character model bound must not yield a clean semantic result. Reject oversized input before model spend instead of reviewing a prefix. Use the existing untrusted-data fence and output sanitization.

The default remains `advise`; `off` still does nothing and `block` retains its existing one-round policy. “Fail closed” here means no claim of completed semantic review on missing evidence, not a new unconditional merge veto. Keep existing model/time/budget/tick limits and one model call per fresh review. Add a semantic-review version to trusted note metadata: a historical same-head note lacking it needs one new pass, while a current-version same-head note remains idempotent and supports label repair. Preserve prior round/hold ownership; migration must not reset the blocking-round allowance.

## MVP

Both semantic checks run in the existing preparation PR review and expose cited findings or an explicit incomplete result. Inline paired fixtures reproduce the Fleet incident and its clarified version. No Fleet implementation, bulk card rewriting, new AI provider, shared result-schema change, new review setting or mandatory-block rollout is included.

## Acceptance

All named tests below are planned additions to we:scripts/conveyor/__tests__/prep-review.test.mjs. They must fail against the pre-build implementation and pass after; this preparation claims no executed red/green result.

- [A1] Executable — test `semantic review requests and retains both checks`: asserts the real generated mandate and judge schema require both evidence tables, and the actual injected judge caller delivers that schema and complete fenced card.
- [A2] Executable — test `semantic findings distinguish obsolete validation from legacy compatibility`: conflict and uncovered requirement results survive reduction and appear in the planned note with source evidence; clarified compatibility and fully covered assertions yield no semantic finding. Multiple uncovered obligations remain distinguishable.
- [A3] Executable — test `semantic review refuses incomplete evidence`: parameterized missing table/completion, missing sections, invented citations, unknown IDs, contradictory clean result, malformed JSON/value and judge rejection all produce an incomplete finding and visible manual-review/rerun fallback. Include docs-, config- and data-only card fixtures; none bypass semantic review.
- [A4] Executable — test `oversized semantic input is incomplete without model spend`: test exactly at and above the existing model bound, including the contradictory requirement beyond the cutoff; oversized input never earns a clean verdict. Test hostile fence-closing and control-character text through input/output producers.
- [A5] Executable — test `semantic upgrade preserves modes limits and historical review ownership`: exercise default/unknown-mode advise, off, block first/second round, old same-head notes, current-version replay, label repair and tick call cap through the actual review/tick callers. Assert one upgrade pass, no second charge on replay and no refreshed blocking allowance.

## Test plan

Add the A1–A5 cases to the existing suite, retaining its current mode, trust, sanitization, schema and replay tests. Update the old seven-ID-only assertion at we:scripts/conveyor/__tests__/prep-review.test.mjs:124 to allow only the explicitly added semantic IDs while retaining the unknown-ID negative case. Update failure-path expectations at :164 and :170 to assert semantic incompleteness, not just an explanatory note alongside a clean result. Existing fixtures must supply valid semantic envelopes deliberately; do not default absent evidence to success.

Use minimal inline card pairs: exact-four preservation against dynamic names; legacy-four acceptance with uniqueness retained; separately labelled Build/PR requirements with only a generic rendering test; and corrected assertions for each clause. Hermetic injected answers prove plumbing and validation, not model comprehension. The Proof plan supplies that distinct evidence.

Run the focused suite through the host heavy queue. In the following executable commands, `we:` is a repository-locus prefix: remove it from each path when executing from the WE root.

## Done when

A1–A5 pass via `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/prep-review.test.mjs`; the semantic live proof below is retained; and `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards` passes. No claim that a green mocked suite proves natural-language reasoning is sufficient.

## Proof plan

At implementation pickup, first add the named assertions and retain the focused red output; after the change retain green output and the diff. Mutation-check omission of the semantic mandate, dropping the new findings in reduction, accepting missing evidence, accepting truncated cards and trusting an unversioned prior note: the corresponding A1–A5 assertion must fail.

Exercise the real configured judge through the same mandate/input/schema seam without publishing comments or changing labels. Record model identity, prompt/schema version, complete sanitized input and result for both Fleet fixture pairs and a hostile instruction fixture. Require the conflicting/uncovered variants to produce cited findings and their clarified variants to clear those findings. A failed/truncated model response is incomplete and requires operator review/rerun; it is not a successful proof. Observe bounded call count and output. Do not invoke the recording side of the separate full-card review operation to obtain this evidence.

## Follow-ups

- After real use, collect false-positive and missed-obligation examples as additional paired fixtures; this MVP does not promise perfect natural-language classification.
- Any proposal to change the advisory default, expand to general PRs, or invalidate historical reviews repository-wide needs separate preparation. This card only upgrades notes encountered by the existing eligible preparation-review path.
