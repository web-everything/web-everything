---
bornAs: xdnwcsk
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/prepare-item-agent-brief.md", "we:skills-src/conveyor/prepare-item-worker-brief.md", "we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "e1d5b705731cc71884a5bebad9444414e28fb332"
tags: []
---

# Prevention — Map design bounds and state requirements to test assertions

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4621-count-plateau-deliveries-today-by-explicit-merge-intent.md` (historical review location; current requirements are under Design) — A planning gate or prompt that extracts all quantitative bounds and specific state requirements from the design text and requires a matching assertion in the test plan.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3346@6eaa32b30ec91aacb39fd8efdf05abb30d242541

## Progress

- **Old premise/scope:** the approval attached a reusable planning omission to only we:backlog/4621-count-plateau-deliveries-today-by-explicit-merge-intent.md:40. That line is now blank immediately beneath MVP; editing that example alone cannot prevent the next plan from omitting requirements.
- **Corrected premise:** the motivating card still illustrates the gap: Design requires at least eight Toronto calendar days, seven buckets, adjacent 60-minute windows, a 120-second baseline, five kind buckets and the latest three full descriptions. Its Test plan mentions bounds generically but does not explicitly assert the latest-three requirement. Unknown versus complete zero, corrupt-history fallback and incomplete comparisons are equally important nonnumeric requirements. These are design-to-assertion obligations, not a request to change the delivery feature.
- **Corrected scope/evidence:** we:skills-src/conveyor/prepare-item-agent-brief.md, under “The method”, requires named test cases and reasons for RED; we:skills-src/conveyor/prepare-item-worker-brief.md requires five concrete sections. Neither requires exhaustive extraction and assertion mapping. The runner reads the latter through `readPrepareBrief` in we:scripts/operations/probation-build-run.mjs. Both templates already share we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs, which tests factual correction and stop boundaries. Scope now includes these two prompt sources and their matching existing test file; no runtime or motivating-card edits are required.
- **Current recheck:** the prior scope remains the two prompts plus their shared contract test. The old description understated current adjacent protections: we:skills-src/conveyor/prepare-item-agent-brief.md:49 now requires an edge-case checklist, and we:skills-src/conveyor/prepare-item-worker-brief.md:38 requires executable Acceptance. Neither maps every design bound/state to an assertion. Preserve those protections and add the mapping alongside them, outside the worker's conditional tests-first block so disabling that policy does not remove this obligation.
- **Caller evidence:** we:scripts/operations/probation-build-run.mjs:449 fills the worker template and appends the card; we:scripts/operations/probation-build-run.mjs:1045 applies tests-first policy on read. No loader/default/setting change is needed: future preparations receive the added obligation through the existing templates; already stamped cards are not retrospectively invalidated. Existing caller regression coverage is we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:3365. The shared parameterization and whitespace normalizer are at we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs:14–16.
- **Delivery check:** local history includes preparation `4c17ac98bd` and its merge `dcdfed08cb`; the current source still lacks extraction/mapping clauses. A GitHub PR number matching 4796 is not evidence of delivering this backlog item. No delivering commit was identified.
- **Estimate:** retain story size 3: two prompt additions of approximately 20 lines each plus approximately 80 lines of shared contract cases, roughly 120 changed lines across the existing three-file scope. No estimatedLoc is added to this story. Runner-owned stamps and all other frontmatter remain untouched.

## Design

Use the prompt option already authorized by the original goal. Insert the obligation in the authoring method at we:skills-src/conveyor/prepare-item-agent-brief.md:44 and before the lifecycle boundary at we:skills-src/conveyor/prepare-item-worker-brief.md:27, outside its tests-first markers. Add the same planning obligation to both scoped preparation templates, before preparation is considered complete. Keep the worker's runner-owned stamp/publication boundary and the agent's existing lifecycle intact.

Require an author to read the full Design and any authoritative design text it incorporates, then place a **Requirements-to-assertions** table within Test plan. Each row carries a stable local requirement ID, repo-qualified source plus heading, the exact requirement, and a named test file/case with an observable expected result. Extract every quantitative bound (including spelled-out numbers, units, minima/maxima, exact cardinalities, zero budgets, windows and boundary inclusivity) and every specific state requirement (including unknown, empty, partial, stale, failure and recovery distinctions). Split combined requirements when separate assertions are needed. Do not infer thresholds absent from the design.

For numeric rows, preserve the actual operator/value/unit and specify boundary cases appropriate to it. For states, specify input or transition and the expected externally observable state. A topic such as “test bounds” or “covers stale data” is not a matching assertion. Planned tests must be labeled planned rather than reported as passing; browser/manual assertions must identify their proof procedure where a unit test cannot establish the behavior.

Reconcile the full extraction against the explicit MVP: every in-MVP row needs a matching assertion; an out-of-MVP row needs an explicit existing cut and a named Follow-up, never silent omission. With no applicable requirements, state that result explicitly after inspection. Missing design evidence or an ambiguous requirement must be resolved from sources or reported through the existing could-not-prepare boundary, never guessed. This is an authoring/review obligation; prompt-presence tests cannot prove semantic completeness of arbitrary prose.

## MVP

- Must add this extraction and mapping obligation to both scoped prompts, including exact bounds, state distinctions, source provenance and concrete assertions.
- Must require reconciliation before readiness/stamping, while preserving runner-owned stamping in worker mode and existing already-done/could-not-prepare exits.
- Must distinguish explicit MVP deferrals from missing assertion coverage and require an explicit no-applicable-requirements statement when appropriate.
- Must extend the shared prompt contract suite for both templates. No new prose parser, stamp gate, product implementation or retrospective backlog rewrite is included.

## Acceptance

All cases below are planned additions to we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs, parameterized over worker and agent. Each new case must fail against the current prompts and pass after implementation; these are prompt-contract guarantees, not a deterministic guarantee of model compliance.

- [A1] Executable: `requires exhaustive quantitative requirement rows` — asserts full Design/incorporated-source inspection, stable IDs, repo-qualified provenance, exact operator/value/unit (including spelled-out numbers and zero), inclusivity and boundary assertions, splitting combined requirements. Current prompts omit this obligation.
- [A2] Executable: `requires state transitions and observable assertions` — asserts every specific state distinction maps to a named test file/case, input/transition and expected result; generic topic coverage is insufficient. Current prompts omit the mapping.
- [A3] Executable: `reconciles every requirement before readiness` — asserts every in-MVP row has coverage, only an existing explicit cut permits a named Follow-up, and inspected designs with no applicable requirements say so. Current prompts have no exhaustive reconciliation.
- [A4] Executable: `refuses unresolved design evidence` — asserts missing/unreadable/incomplete design evidence and ambiguous thresholds require source resolution or could-not-prepare, never invented values or readiness. Current generic fork exits do not impose this evidence check.
- [A5] Executable: `delivers unconditional mapping without changing lifecycle` — asserts mapping lies outside the worker tests-first marker range, both callers' templates carry it before completion, worker stamping remains runner-owned, agent stamping remains after reconciliation, and existing acceptance/edge-case requirements remain. The mapping/location assertions fail today; lifecycle assertions remain green. No persisted-state migration or new setting/default is introduced.
- [A6] Executable: `distinguishes planned assertions from observed proof` — asserts planned tests are labeled planned, manual/browser assertions name a proof procedure, and prompt tests are not presented as proof of semantic completeness. These clauses are absent today.

## Test plan

Extend we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs using its existing parameterized worker/agent cases:

1. Assert both prompts require the Requirements-to-assertions table, source provenance, exact quantitative bounds with units/boundaries, specific state requirements, and a named case plus expected result. New assertions fail RED against both current templates because those obligations are absent.
2. Assert both prompts require reconciliation of every in-MVP requirement, explicit Follow-ups for deliberate cuts, and an explicit none-found outcome. These obligations are absent today and must fail RED before the edits.
3. Assert both prompts forbid inventing missing thresholds and require resolving missing/ambiguous evidence or the existing could-not-prepare exit. Check the full obligation, not merely the already-present exit token; the added requirement is RED today.
4. Keep all existing factual-drift, frontmatter allow-list and lifecycle checks green. Assert the worker still delegates stamping to the runner. These are preservation tests, not newly failing behavior tests.

Requirements-to-assertions mapping for this change (all named cases are planned in we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs):

| ID | Source | Requirement and observable assertion |
|---|---|---|
| R1 | This card, Design paragraph 2 | Full extraction, exact numeric semantics and provenance → A1 rejects omission of any required clause in either prompt. |
| R2 | This card, Design paragraphs 2–3 | State input/transition, named case and expected result → A2 rejects topic-only wording. |
| R3 | This card, Design paragraph 4 | Every in-MVP row reconciled, explicit cuts/Follow-ups and none-found → A3 checks all three outcomes. |
| R4 | This card, Design paragraph 4 | Missing evidence or ambiguity refuses readiness → A4 requires source resolution or could-not-prepare and forbids guessed thresholds. |
| R5 | This card, Design paragraph 1 and Progress caller evidence | Both preparation surfaces receive the obligation without changing lifecycle → A5 checks placement plus existing worker/agent boundaries. |
| R6 | This card, Design paragraphs 3–4 | Planned versus observed status and manual proof limitations → A6 checks explicit honesty/procedure clauses. |

There are no new quantitative runtime limits or deferred design requirements in this MVP. Include unreadable and incomplete evidence explicitly in the new prompt language; an explicit none-found result is allowed only after inspection, never as a fallback for a failed read. Existing acceptance requirements and the agent edge-case checklist remain additive.

Use robust paragraph/whitespace-normalized assertions for required clauses rather than a snapshot of the entire prompt. Tests establish prompt delivery, not the quality of a model's resulting plan.

## Proof plan

1. At implementation, add A1–A6 first, then run the scoped Vitest suite through the host heavy-run queue; record RED before changing prompts and GREEN afterward, preserving existing tests. From WE, invoke Node on we:scripts/readiness/heavy-admission.mjs with `run -- npx vitest run` and the repo-relative argument for we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs (strip the documentation-only `we:` prefix when passing paths). Also run the existing caller regression in we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs filtered with `-t 'keeps probation-only instructions'` through that same queue. Run `npm run check:standards` through that queue at implementation. If busy, wait once using admission's supported wait option, then report; never poll. This card-only preparation leaves runner-owned checks and stamping to the runner.
2. Exercise each rendered prompt in an isolated, nonpublishing planning trial using a disposable copy of the motivating design. Require the output table to retain at least eight local calendar days, seven daily buckets, adjacent 60-minute windows, 120-second baseline, five kind buckets, latest three full descriptions and zero additional GitHub calls. Check the exact assertions, not just whether those numbers appear. Record the prompt revision and resulting artifact without stamping or publishing the source card.
3. In the same trial, verify unknown versus complete zero, corrupted history versus empty history, partial coverage versus a comparable window, and restoration after restart each have input/expected-result assertions. Supply an intentionally incomplete test plan omitting latest-three and corrupt-history assertions: the revised preparation must fill those gaps or explicitly report why it cannot, rather than claim readiness unchanged.
4. Also try a design with no bounds/states, one with an explicit MVP deferral and one with an unresolved threshold. Observe explicit none-found, a traceable Follow-up and a clarification/could-not-prepare outcome respectively. Treat any missed requirement as a failed prompt trial; do not claim a deterministic semantic gate from these examples.

## Follow-ups

- A machine-readable requirement manifest or deterministic stamp-time coverage checker would be separate work; this MVP does not claim prose extraction can be exhaustively verified by regex.
- Extend the mapping method to decision preparation or other authoring surfaces only in a separately scoped item.
- Any repair of the motivating delivery card's missing assertions belongs to its own preparation; it remains read-only evidence for this prevention.
