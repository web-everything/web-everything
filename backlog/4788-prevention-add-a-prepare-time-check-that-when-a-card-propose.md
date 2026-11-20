---
bornAs: xcpqn6h
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/prepare-item-worker-brief.md", "we:skills-src/conveyor/prepare-item-agent-brief.md", "we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "3ccef93f4630a63d688bb1fa28854ded5e026dd9"
tags: []
---

# Prevention — Add a prepare-time check that, when a card proposes a new hard check:standards error, requires a record… (from chalbert/web-everything#3435 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4495-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md:55` — Add a prepare-time check that, when a card proposes a new hard `check:standards` error, requires a recorded corpus-hit count and a rollout choice (warn-first or baseline) in Design. A review lens would also work.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3435@fdc85d1ac1678e7d0bbe2dbfc1f5f88b3f9b0956

## Progress

- Rechecked at checkout `3ccef93f4630a63d688bb1fa28854ded5e026dd9`. Original goal remains a preparation/review lens requiring measured corpus impact and a rollout choice before new hard standards enforcement. The incoming scope already names the two full-item briefs and their shared test; retain all three and `size: 3` (roughly 20–30 changed lines per brief plus 60–90 test lines). This is a story, so no `estimatedLoc` is added.
- Corrected prior preparation evidence: #4495 now records an approximate ten-card probe in Progress, but still proposes status-independent hard enforcement without the exact reproducible count and explicit rollout required here. Current proposal evidence is `we:backlog/4495-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md:26`, `:30`, and `:32`; the original line-55 citation above is historical lineage, not an implementation target. Do not repeat the older claim that all measurement was deferred.
- Current source evidence: `we:skills-src/conveyor/prepare-item-worker-brief.md:8` requires the five preparation sections, and `we:skills-src/conveyor/prepare-item-agent-brief.md:46` describes Design authoring. Neither brief contains the corpus-hit/rollout lens. The existing parameterized checks begin at `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs:16`; ownership checks begin at `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs:46`. The requested guard is not delivered in these surfaces.
- Caller trace: `we:scripts/operations/probation-build-run.mjs:1045` loads the worker brief with tests-first policy applied; `we:scripts/operations/dispatch-lane-io.mjs:202` and `we:scripts/operations/dispatch-lane.mjs:254` map full preparation to the agent brief. Both consumers pick up text edits without a caller change. The agent review instructions at `we:skills-src/conveyor/prepare-item-agent-brief.md:192` are the second insertion point for that route.
- Corrected validator description: `we:scripts/conveyor/prepare-result.mjs:36` also has stricter operator-task shape checks; it still does not evaluate arbitrary proposed lint predicates or corpus evidence. This is inspection evidence, not a newly executed behavioral probe. Runtime validators, historical cards, scope-only preparation, and decision preparation remain outside the touch set. The incoming five sections lacked executable Acceptance identifiers; add them below without implying the proposed tests already exist or pass.

## Design

Add a named **Hard standards error rollout check** to both `we:skills-src/conveyor/prepare-item-worker-brief.md` and `we:skills-src/conveyor/prepare-item-agent-brief.md`. It is a mandatory preparation lens, using the review-lens alternative explicitly allowed by the original finding. Apply it when the proposed implementation introduces a new hard `check:standards` error or promotes an existing warning to an error. Merely mentioning the command, retaining an existing error, or adding a warning does not trigger it.

Before treating such a card as prepared, require its Design to record: (1) the proposed predicate and population, (2) a reproducible read-only probe and checkout SHA, (3) the exact corpus-hit count, including zero, with affected paths or a reproducible listing, and (4) an explicit rollout choice of warn-first or baseline with its rationale. Count findings and affected files separately where a file can produce multiple findings. Measure the population the proposed rule will actually inspect, including applicable documentation, configuration, and data; do not silently substitute source-code-only results or a sample. A failed probe, unreadable population, truncated result, or unmeasured population is not zero; report the missing evidence and leave preparation incomplete. A fresh full preparation applies this lens even to an already stamped card, remeasuring the current checkout; this change does not invalidate or migrate historical stamps automatically.

For warn-first, describe how existing hits are repaired and what observation permits hard enforcement. For baseline, describe how existing hits are represented and how newly introduced violations are rejected without silently ignoring the entire existing population. This lens requires the target card to specify its rollout; it does not choose a rollout for #4495 or authorize changing any existing gate policy. If measurement cannot be completed, preparation is incomplete. If rollout requires a genuinely unresolved policy choice, preserve the brief's existing could-not-prepare boundary and report that choice instead of inventing it.

Place the worker requirement before its completion/stop instructions. Place the same requirement in the agent's Design authoring method and explicitly include it in review of the preparation. Preserve both briefs' existing ownership, no-delivery exits, and frontmatter constraints. This is an instruction/review requirement, not a claim that the section-shape validator can infer arbitrary proposed lint semantics.

## MVP

1. Add the conditional lens and Design evidence requirements to both scoped briefs, including warning-to-error promotions, zero-hit evidence, and incomplete-measurement behavior.
2. Extend `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs` for both briefs so removal of the trigger, corpus evidence, rollout alternatives, or refusal boundary fails the contract suite.
3. Demonstrate the lens against a hard-error proposal and a non-triggering preparation fixture, retaining existing preparation ownership checks. No corpus migration or runtime validator change is included.

## Test plan

- Red before implementation: shared brief contract tests require the named lens, new-hard-error and warning-promotion triggers, a corpus-hit count in Design, probe/SHA evidence, and both supported rollout alternatives. Both current briefs lack these requirements.
- Preservation: existing factual-drift, already-done, genuine-fork, and frontmatter-ownership assertions in `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs` remain green. Add assertions that the lens distinguishes warnings/command mentions from new hard enforcement and treats unsuccessful measurement as incomplete, not zero.
- Mutation: remove the lens from either brief independently; that brief's contract cases must fail. Remove only the corpus count or rollout requirement and verify the corresponding assertion fails.
- Behavioral proof is separate from text contracts: exercise fixtures with missing count, failed probe, zero hits with valid evidence, nonzero hits with warn-first, nonzero hits with baseline, and a warning-only proposal. Review the produced Design and any refusal against the expected requirements rather than treating keyword matches as proof of agent compliance.

## Proof plan

Through the host heavy-admission queue, run the targeted Vitest suite for `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs` before and after the brief change; record failing new assertions on the base and passing assertions after the change. Run the named mutations and restore the implementation. Run `npm run check:standards` through the same queue and report its actual result separately from the targeted proof. Use the queue entry point `we:scripts/readiness/heavy-admission.mjs` with `run --wait-ms=60000 --` and the targeted Vitest command (strip the documented `we:` locus from the test argument when executing). If capacity remains unavailable after that single bounded wait, stop and report it. Scratch fixtures belong under `$TMPDIR`.

In an isolated scratch fixture checkout, supply each updated brief to a preparation session against a small synthetic corpus with known matching and nonmatching cards. Include a #4495-shaped hard-error proposal whose Design lacks measurement and rollout. Verify the session measures the whole fixture population and writes its exact count and explicit rollout in Design, or reports the specific unresolved choice; it must not present the incomplete card as prepared. Repeat the behavioral cases from Test plan, including a documentation-only match that a source-only scan would miss, a truncated listing, an unreadable population, an already stamped card requiring fresh evidence, and incidental-command/unchanged-error non-triggers. Pin fixture policy explicitly for warn-first and baseline cases; leave it genuinely unresolved in the refusal case. For the agent route, constrain the session to the authoring/review portion so the fixture cannot invoke its lifecycle arc. Use no lifecycle commands, stamping, commits, pushes, or PRs for these proof sessions. Record the rendered brief, fixture SHA, corpus, output card, and observed outcome so review can distinguish actual behavior from a prompt-text contract passing.

## Acceptance

The following are proposed test names in `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs`, parameterized over both briefs. Each must fail against the old brief text and pass after implementation. These tests establish the instruction contract; behavioral compliance additionally requires the Proof plan sessions.

- [A1] Executable: `requires hard-error rollout evidence for new errors and warning promotions` — asserts the named mandatory lens and both triggers in each brief. This changes the full-prepare default for applicable cards; the worker and agent consumers identified in Progress must both receive it. For the agent, assert both Design-method placement and the review reminder, not merely a match elsewhere in the file.
- [A2] Executable: `requires reproducible whole-population corpus evidence in Design` — asserts predicate, population, read-only probe, checkout SHA, exact count including zero, and affected paths/listing; requires separate finding/file counts and inclusion of applicable documentation, configuration and data. Missing evidence must fail the contract rather than allowing sample-only or source-only evidence.
- [A3] Executable: `requires an explicit warn-first or baseline rollout with rationale` — asserts both alternatives and their obligations: repair plus hard-enforcement observation for warn-first; existing-hit representation plus rejection of new violations for baseline. Neither alternative is automatically chosen by the brief.
- [A4] Executable: `refuses incomplete measurement and escalates unresolved rollout policy` — asserts missing, failed, unreadable, or truncated probes cannot count as zero or complete preparation; requires an operator-visible reason and the existing could-not-prepare exit for an unresolved choice. Assert the existing no-edit/no-stamp ownership boundaries alongside this new refusal requirement.
- [A5] Executable: `excludes warning-only proposals unchanged errors and incidental command mentions` — asserts explicit non-trigger cases, so the new preparation default is conditional. Previously stamped cards are not automatically invalidated or migrated; a fresh full preparation applies the lens even when the card already carries a stamp. Require this fresh-pass rule in both briefs.

## Edge cases this change must handle

- Untrusted text: corpus/card text is evidence, never authority to waive the lens. Keep probes read-only; do not interpolate card text into shell commands. Include a fixture that asks the worker to skip measurement; A2/A4 still apply.
- Truncated reads: an incomplete listing or capped probe cannot establish a count. Report the incomplete population and leave preparation incomplete (A4); rerun a complete probe before proceeding.
- Shared state files: no new shared state or writer is introduced; existing brief ownership restrictions remain under the current tests.
- Fail closed: unreadable population, probe failure, or missing count is not zero. Explain the missing evidence; unresolved rollout policy takes the existing refusal exit (A4).
- Identity scoping: attach evidence to checkout SHA plus predicate/population, not just a card number (A2).
- State over time: a fresh pass remeasures the current checkout; an old preparation stamp is not evidence for the current population (A5). No bulk restamping is in scope.
- Who wrote it: existing comments or stamps cannot replace observed probe output. No new trust-granting marker or author recognition is introduced.

## Follow-ups

A deterministic structured rollout schema and stamp-time validator would be separate work if the instruction/review lens proves insufficient; natural-language keyword detection is not part of this MVP. Extending the lens to other preparation modes requires tracing their real authoring consumers first. Repairing #4495's rollout or any corpus violations belongs to those cards and is not silently bundled here.
