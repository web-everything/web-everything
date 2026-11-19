---
bornAs: xfczwrd
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-core.mjs", "we:scripts/lib/__tests__/review-core.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "781dec0e23810288560e3992187a41e4f72ca4b4"
tags: []
---

# Prevention — Add a card-authoring check that every field a Done-when names is traceable to a fetched source, for exa… (from chalbert/web-everything#3226 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. The review of what is now `we:backlog/4687-pin-why-conflicting-pr-reads-queued-in-classifypr.md` requested a card-authoring check that every field named by Done-when criteria is traceable to a fetched source, for example by checking the actual PR query field list. The original request explicitly permits a review-lens fallback.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3226@9be15107d23e44229152ac35a852a2d84e4486a8

## Acceptance

The executable guarantees below concern instructions delivered to reviewers, not deterministic detection by a prose parser. Each named regression is to be added in `we:scripts/lib/__tests__/review-core.test.mjs` and must fail against the current brief, then pass with the implementation.

- [A1] Executable — `4812 traces each criterion field through acquisition and forwarding`: assert the generated claim-accuracy mandate requires criterion → consumer → actual acquisition field list → projection/normalization, and rejects invented fixture properties as production evidence.
- [A2] Executable — `4812 distinguishes planned and derived fields across card kinds`: assert the generated mandate accepts explicit acquisition/forwarding/test plans as future work, traces derived values through inputs and transformations, and applies to source, documentation, configuration and data criteria.
- [A3] Executable — `4812 leaves unavailable provenance unverified`: assert the mandate requires unreadable, missing or incomplete evidence to be reported as unverified with the missing source named and a request for that source or an isolated tool-bearing review. It must forbid both a clean-check claim and an absence diagnosis from unavailable evidence. This is the fail-closed reporting path, not a new verdict policy.
- [A4] Executable — `4812 reaches default and caller-shaped panel mandates without changing seats`: assert A1–A3 instructions appear with omitted optional arguments and with the existing callers' net-file, fenced-goal, round, aim and diff-basis options; assert the new paragraph is absent from other lenses and the mandatory/advisory lists retain their current values. The new text assertion makes this regression red before implementation even though the compatibility assertions already pass.

Observed proof supplements A1–A3: retain review inputs, supplied sources and resulting findings for an acquisition gap, an explicit future acquisition plan, a derived field and unavailable evidence. Prompt-string assertions alone do not establish review quality.

## Progress

- Original premise/scope: the mechanically filed item scoped only the old alias card `we:backlog/4687-pin-why-conflicting-pr-reads-queued-in-classifypr.md`, with a stale line-17 citation and no executable acceptance criterion or matching test path.
- Corrected location: `we:backlog/4687-pin-why-conflicting-pr-reads-queued-in-classifypr.md` has `bornAs: xzv8r3e`. Its current Design explicitly plans acquisition of `mergeable` and forwarding to the classifier. Editing that card again would not provide the reusable prevention requested here.
- Source evidence: `we:scripts/conveyor/reconcile-pass.mjs:304` requests `mergeStateStatus` but not `mergeable`; the snapshot list at `we:scripts/conveyor/reconcile-pass.mjs:327` derives from it and adds completeness fields, while the direct CLI query at `we:scripts/conveyor/reconcile-pass.mjs:465` uses the original list. `we:scripts/progress-board.mjs#classifyPr` currently tests `DIRTY` and `BEHIND` before acceptance. These observations support the missing-acquisition failure class, not a historical diagnosis of particular PRs.
- Existing prevention is partial: `we:scripts/lib/review-core.mjs#LENS_HUNT_BRIEF` already tells claim-accuracy reviewers to inspect Done-when criteria and resolve claims against source. Its enumerated hunt shapes do not require tracing each input field through fetch and forwarding. `buildPanelMandate` already includes the brief. `we:scripts/lib/__tests__/review-core.test.mjs` already tests the brief and its panel wiring. The generic lens is delivered; this specific check is not.
- Corrected scope: extend that existing lens and its matching test, using the fallback expressly allowed by the originating request. No new lens, automatic prose parser, mandatory-review policy or PR-query change belongs to this prevention item. The runtime files above are evidence only.

- Re-preparation correction: the prior card incorrectly asserted `bornAs: 4687` and described shared/direct reads as using one identical list. Current evidence is `we:backlog/4687-pin-why-conflicting-pr-reads-queued-in-classifypr.md:2` and the two field lists cited above. The current two-file scope remains correct; runtime acquisition is evidence, not this item's implementation.
- Not already delivered: `we:scripts/lib/review-core.mjs:1972` enumerates six hunt shapes without per-field provenance, and the tests at `we:scripts/lib/__tests__/review-core.test.mjs:1845` cover registry/wiring rather than that obligation. The append point remains `we:scripts/lib/review-core.mjs:1140`.
- Caller audit: the CLI at `we:scripts/review-core-cli.mjs:248`, convergence at `we:scripts/converge-cli.mjs:282`, and judge builders at `we:scripts/operations/review-pr.mjs:1580` and `we:scripts/operations/review-pr.mjs:1662` consume the shared builder. No caller signature or selection default needs changing; only claim-accuracy's default instruction text expands. Cover these argument shapes in the scoped test file.
- Size retained at 3: approximately 20–35 changed source lines at `we:scripts/lib/review-core.mjs:1972` plus 60–100 test lines beside `we:scripts/lib/__tests__/review-core.test.mjs:1845`, with four observed review cases. This is a story, so no `estimatedLoc` is added. Existing preparation stamps are untouched; the runner owns restamping and checks.

## Design

Extend the existing claim-accuracy hunt brief in `we:scripts/lib/review-core.mjs`. When a changed card's Done-when criterion names input fields, require a per-field trace: criterion → consumer → acquisition source → any projection or normalization before the consumer. For a fetched PR field, check the actual query's field list, not a same-named constant in another reader. A fixture with an invented property is not acquisition evidence.

Distinguish existing behavior from planned work. An absent field is a defect in a card that promises behavior without acquiring it; a card explicitly planning query acquisition, forwarding and matching tests is a valid plan. Derived fields must identify their inputs and transformation, rather than being required literally in a remote query. Apply the check to criteria in documentation, configuration and data changes as well as source changes.

Use the existing evidence-grounded finding format and existing advisory claim-accuracy seat. With tools, resolve the cited source at the reviewed revision using the existing isolated-review rules; without tools or source excerpts, report the trace as unverified and name the missing evidence, requesting source excerpts or an isolated tool-bearing review as the operator-visible fallback. Treat incomplete source excerpts the same way. Do not infer absence from unavailable evidence or claim a check passed. This addition does not alter verdict aggregation or seat selection.

## MVP

1. **Must 1:** add the field-by-field acquisition and forwarding check to the existing claim-accuracy brief in `we:scripts/lib/review-core.mjs`, with `PR_LIST_JSON_FIELDS` as an example rather than a universal schema.
2. **Must 2:** cover planned acquisition, derived fields and all card input kinds (source, docs, config and data); reject fixture-only evidence as proof of production acquisition.
3. **Must 3:** specify honest handling of unreadable or unavailable evidence, and extend `we:scripts/lib/__tests__/review-core.test.mjs` to pin these instructions and their presence in the generated panel mandate. Preserve existing lens membership and verdict policy. Add A4 coverage for default and caller-shaped mandates; no persisted-state migration or new setting is needed.

## Test plan

Extend the existing hunt-brief test group in `we:scripts/lib/__tests__/review-core.test.mjs`. Assert the new acquisition/forwarding obligation, the fixture-only counterexample, planned/derived-field treatment and unavailable-evidence branch are present in the generated claim-accuracy mandate. Keep the existing frozen registry, other-lens and panel-wiring assertions. Removing the new brief paragraph must redden the targeted regression.

During implementation, run A1–A4 by their `4812` test-name prefix, then the whole matching Vitest file through the host heavy-run queue. Command template (strip `we:` from repository-relative argv paths when executing): `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/review-core.test.mjs -t 4812`; omit the filter for the full file. Run the standards check through the same queue with `npm run check:standards` as its child command. If busy, wait once using the queue's own wait option, then report rather than polling. Exercise three small review inputs: an absent `mergeable` field with no acquisition plan; the same criterion with an explicit acquisition/projection/test plan; and the same criterion with source evidence unavailable. Include a derived-field example to ensure the rule does not require every computed value in a remote query. Preparation checks and stamping remain runner-owned.

## Proof plan

Capture red-before/green-after output for the targeted mandate regression and inspect the actual generated claim-accuracy mandate. Then run the four review exercises (including the derived-field case) with the same evidence boundary, retaining the input and findings. The incomplete card should yield a concrete acquisition gap; the complete plan should not be rejected just because its implementation is future work; the evidence-starved case should disclose its limit. Do not use a successful prompt-string test as evidence that reviewers reliably catch every field omission. Use the same generated mandate and supplied evidence for each exercise; keep the records in the implementation review evidence. For the derived-field case, require an input-and-transformation trace without demanding a literal remote field. Remove each new instruction group independently and confirm its named regression fails. No live PR mutation is needed.

## Follow-ups

If observed reviews still miss field acquisition despite this explicit check, use those misses to specify a structured field-provenance contract and deterministic validator in a separate item. Do not introduce a repository-wide free-prose field parser here. Any proposal to make claim-accuracy mandatory is a separate review-policy decision. The runtime correction remains owned by #4687.
