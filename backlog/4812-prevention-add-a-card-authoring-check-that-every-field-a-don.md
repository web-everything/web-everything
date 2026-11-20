---
bornAs: xfczwrd
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-core.mjs", "we:scripts/lib/__tests__/review-core.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "280c9f8d5aaecf87303d48638a938473781b9ae3"
tags: []
---

# Prevention — Add a card-authoring check that every field a Done-when names is traceable to a fetched source, for exa… (from chalbert/web-everything#3226 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. The review of what is now `we:backlog/4687-pin-why-conflicting-pr-reads-queued-in-classifypr.md` requested a card-authoring check that every field named by Done-when criteria is traceable to a fetched source, for example by checking the actual PR query field list. The original request explicitly permits a review-lens fallback.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3226@9be15107d23e44229152ac35a852a2d84e4486a8

## Acceptance

The following are proposed tests in `we:scripts/lib/__tests__/review-core.test.mjs`, under the existing hunt-brief group. Each new test must fail against the pre-build brief and pass after implementation; existing compatibility assertions alone are not red-before evidence.

- [A1] Executable — `field provenance traces acquisition and forwarding` asserts that the generated claim-accuracy mandate requires every criterion input to be traced through its consumer, actual acquisition query/source and projections, and explicitly rejects fixture-only acquisition evidence.
- [A2] Executable — `field provenance distinguishes plans and derived inputs` asserts that the generated mandate accepts an explicit acquisition/forwarding/test plan as planned work, requires derived inputs and transformations to be traced, and covers source, documentation, configuration and data claims.
- [A3] Executable — `field provenance leaves unavailable evidence unverified` asserts that unreadable, missing or incomplete evidence requires an unverified result naming the missing evidence and requesting the source/reviewed-revision excerpts needed to complete the check; neither absence nor success may be inferred. This is the fail-closed evidence path, not a new automatic verdict rule.
- [A4] Executable — `field provenance reaches panel callers without changing other lenses` asserts the new instructions occur in both default and explicitly configured claim-accuracy panel mandates (including net-file context and tool-free context), while other lenses omit them and retain the existing common rules. Preserve registry membership, seat selection and verdict policy; no caller API or setting default changes.

Observed proof supplements A1–A3: retain review input/source excerpts and findings for a missing acquisition, a complete future plan, a derived field, and unavailable evidence. These exercises demonstrate review behavior for those examples, not a guarantee that a prose lens catches every omission.

## Progress

- Original premise/scope: the mechanically filed item scoped only the old alias card `we:backlog/4687-pin-why-conflicting-pr-reads-queued-in-classifypr.md`, with a stale line-17 citation and no executable acceptance criterion or matching test path.
- Corrected location: `we:backlog/4687-pin-why-conflicting-pr-reads-queued-in-classifypr.md` has `bornAs: xzv8r3e`. Its current Design explicitly plans acquisition of `mergeable` and forwarding to the classifier. Editing that card again would not provide the reusable prevention requested here.
- Source evidence: `we:scripts/conveyor/reconcile-pass.mjs#PR_LIST_JSON_FIELDS` currently requests `mergeStateStatus` but not `mergeable`; `we:scripts/conveyor/reconcile-pass.mjs:465` uses it for direct CLI reads; shared reads use the derived `SNAPSHOT_LIST_FIELDS` at `we:scripts/conveyor/reconcile-pass.mjs:327`, consumed at lines 485 and 508 of that same file. `we:scripts/progress-board.mjs#classifyPr` currently tests `DIRTY` and `BEHIND` before acceptance. These observations support the missing-acquisition failure class, not a historical diagnosis of particular PRs.
- Existing prevention is partial: `we:scripts/lib/review-core.mjs#LENS_HUNT_BRIEF` already tells claim-accuracy reviewers to inspect Done-when criteria and resolve claims against source. Its enumerated hunt shapes do not require tracing each input field through fetch and forwarding. `buildPanelMandate` already includes the brief. `we:scripts/lib/__tests__/review-core.test.mjs` already tests the brief and its panel wiring. The generic lens is delivered; this specific check is not.
- Corrected scope: extend that existing lens and its matching test, using the fallback expressly allowed by the originating request. No new lens, automatic prose parser, mandatory-review policy or PR-query change belongs to this prevention item. The runtime files above are evidence only.

- Revalidation: the previous preparation claimed `bornAs: 4687` and a single identical field list for both reader paths. The current identity is `bornAs: xzv8r3e` at `we:backlog/4687-pin-why-conflicting-pr-reads-queued-in-classifypr.md:2`; the direct list at `we:scripts/conveyor/reconcile-pass.mjs:304` still omits `mergeable`, while the shared list is derived and adds snapshot metadata. These corrections do not change the prevention goal or the two-file scope.
- Current implementation evidence: `we:scripts/lib/review-core.mjs:1972` enumerates six claim-hunt shapes without field provenance; `we:scripts/lib/review-core.mjs:1138` appends the brief to panel mandates. Existing coverage at `we:scripts/lib/__tests__/review-core.test.mjs:1845` checks registry/wiring/common rules, not acquisition. The missing prevention is not already delivered.
- Caller inspection: `we:scripts/review-core-cli.mjs:248`, `we:scripts/converge-cli.mjs:282` and `we:scripts/operations/review-pr.mjs:1580`/`we:scripts/operations/review-pr.mjs:1662` call the existing panel builder. The added brief flows through that API; no caller edits or default migrations are planned.
- Size remains 3: approximately 20–35 changed lines in the brief at `we:scripts/lib/review-core.mjs:1972` and 60–90 test lines beside `we:scripts/lib/__tests__/review-core.test.mjs:1845`, plus four bounded observed review exercises. This is a story, so no task-only estimatedLoc is added. Existing preparation stamps are left untouched for the runner.

## Design

Extend the existing claim-accuracy hunt brief in `we:scripts/lib/review-core.mjs`. When a changed card's Done-when criterion names input fields, require a per-field trace: criterion → consumer → acquisition source → any projection or normalization before the consumer. For a fetched PR field, check the actual query's field list, not a same-named constant in another reader. A fixture with an invented property is not acquisition evidence.

Distinguish existing behavior from planned work. An absent field is a defect in a card that promises behavior without acquiring it; a card explicitly planning query acquisition, forwarding and matching tests is a valid plan. Derived fields must identify their inputs and transformation, rather than being required literally in a remote query. Apply the check to criteria in documentation, configuration and data changes as well as source changes.

Use the existing evidence-grounded finding format and existing advisory claim-accuracy seat. With tools, resolve the cited source at the reviewed revision using the existing isolated-review rules; without tools or source excerpts, report the trace as unverified and name the missing evidence. Do not infer absence from unavailable evidence or claim a check passed. This addition does not alter verdict aggregation or seat selection.

## MVP

1. **Must 1:** add the field-by-field acquisition and forwarding check to the existing claim-accuracy brief in `we:scripts/lib/review-core.mjs`, with `PR_LIST_JSON_FIELDS` as an example rather than a universal schema.
2. **Must 2:** cover planned acquisition, derived fields and all card input kinds (source, docs, config and data); reject fixture-only evidence as proof of production acquisition.
3. **Must 3:** specify honest handling of unreadable or unavailable evidence, and extend `we:scripts/lib/__tests__/review-core.test.mjs` to pin these instructions and their presence in the generated panel mandate. Preserve existing lens membership and verdict policy.

## Test plan

Extend the existing hunt-brief test group in `we:scripts/lib/__tests__/review-core.test.mjs`. Assert the new acquisition/forwarding obligation, the fixture-only counterexample, planned/derived-field treatment and unavailable-evidence branch are present in the generated claim-accuracy mandate. Keep the existing frozen registry, other-lens and panel-wiring assertions. Removing the new brief paragraph must redden the targeted regression.

Run the four named acceptance tests and existing hunt-brief compatibility tests through the host heavy-run queue, then the whole scoped test file and the standards gate. Commands below are runnable from WE; shell variables resolve the repo-qualified references without treating the `we:` prefix as a filesystem directory:

```sh
queue_ref=we:scripts/readiness/heavy-admission.mjs
test_ref=we:scripts/lib/__tests__/review-core.test.mjs
node "${queue_ref#we:}" run -- npx vitest run "${test_ref#we:}" -t 'field provenance|LENS_HUNT_BRIEF'
node "${queue_ref#we:}" run -- npx vitest run "${test_ref#we:}"
node "${queue_ref#we:}" run -- npm run check:standards
```

If admission is busy, wait once using the queue's supported wait option, then stop and report; do not poll. These commands are implementation checks, not checks performed by this preparation worker. Exercise three small review inputs: an absent `mergeable` field with no acquisition plan; the same criterion with an explicit acquisition/projection/test plan; and the same criterion with source evidence unavailable. Include a derived-field example to ensure the rule does not require every computed value in a remote query. Preparation checks and stamping remain runner-owned.

## Proof plan

Capture red-before/green-after output for the targeted mandate regression and inspect the actual generated claim-accuracy mandate. Then run the four review exercises (missing acquisition, explicit future plan, derived input, unavailable evidence) with the same evidence boundary, retaining the input and findings. For the derived case, supply both the fetched inputs and transformation and verify that the reviewer does not demand the computed field in the remote query. The incomplete card should yield a concrete acquisition gap; the complete plan should not be rejected just because its implementation is future work; the evidence-starved case should disclose its limit. Do not use a successful prompt-string test as evidence that reviewers reliably catch every field omission. No live PR mutation is needed.

## Follow-ups

If observed reviews still miss field acquisition despite this explicit check, use those misses to specify a structured field-provenance contract and deterministic validator in a separate item. Do not introduce a repository-wide free-prose field parser here. Any proposal to make claim-accuracy mandatory is a separate review-policy decision. The runtime correction remains owned by #4687.
