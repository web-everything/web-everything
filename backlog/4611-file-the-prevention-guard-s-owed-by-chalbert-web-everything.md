---
bornAs: xkn31un
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-backlog-item.mjs", "we:scripts/__tests__/check-backlog-item.test.mjs", "we:docs/agent/backlog-workflow.md"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "00ecbc1d32b46ff3dd39bd76f6462915f84232cc"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3107's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4599-define-human-forge-edits-and-durable-acknowledgements-at-the.md:4` — Make check-backlog-item or check-standards reject any diff that flips a kind:decision to status: resolved without codifiedIn, so it applies to hand edits as well as the verb. Today only the verb and the legacy G6 audit cover this.
2. `we:backlog/4599-define-human-forge-edits-and-durable-acknowledgements-at-the.md:33` — Add a resolve-time prompt or checklist that walks the Done-when clauses, or requires spun-off follow-up ids for anything left unaddressed. Failing that, add a review lens for decision resolutions that compares the ruling with the Done-when.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3107@6c66a5ba5bc68b028cb1db8083f1a1cf3f75ea7e

## Progress

Preparation refresh (2026-11-19): the prevention remains outstanding. Source inspection finds no codification check in we:scripts/check-backlog-item.mjs; the resolve checklist in we:docs/agent/backlog-workflow.md:270-280 still lacks explicit clause-by-clause decision accounting. This is source evidence, not a claim that a new regression has been executed.

- **Old premise/scope:** the previous preparation described a presence-only guard while also requiring `validateCodifiedIn`, claimed any nonblank scalar supplied presence, and described fixture cleanup without the current isolated-backlog interface. The original incident references were frontmatter line 4 and a stale Done-when line 36.
- **Corrected premise/scope:** retain the three scoped files. Reject missing codification and reuse the existing scalar validator, including its existing pointer grammar; arbitrary nonblank strings do not pass. Use temporary backlogs, never fixtures in the real backlog. The incident Done-when is now at we:backlog/4599-define-human-forge-edits-and-durable-acknowledgements-at-the.md:33; its ruling begins at line 37. No substantive ruling is supplied by this prevention story.
- **Source evidence:** we:scripts/backlog/frontmatter.mjs:174-183 accepts `one-off` or the existing docs Markdown pointer grammar and calls `.trim()` on its input; non-string YAML values therefore need a type guard. The resolution transition already invokes it at we:scripts/backlog/frontmatter.mjs:261. The per-item checker parses fallback frontmatter at we:scripts/check-backlog-item.mjs:75-80 and reports YAML errors at line 89, but never calls that validator. Parse safely for loaded items too, rather than relying on loader field exposure.
- **Changed callers/defaults:** we:package.json:73 exposes the checker as `check:item`. The explicit directory flag, environment override and default real-backlog path are selected at we:scripts/check-backlog-item.mjs:34-37. Existing caller compatibility tests at we:scripts/__tests__/check-backlog-item.test.mjs:95 cover positional ids, `--item`, flag ordering, flag-over-environment precedence and missing targets. Preserve these interfaces; the intentional default change is that explicitly checking a resolved legacy decision without codification now fails.
- **Test isolation evidence:** we:scripts/__tests__/check-backlog-item.test.mjs:41 drives real subprocesses; lines 60-64 create and remove temporary backlogs, and the suite checks the real backlog stays untouched. Extend this harness rather than the obsolete real-backlog fixture pattern.
- **Size:** retain size 3: approximately 25–40 changed lines in we:scripts/check-backlog-item.mjs, 100–140 in we:scripts/__tests__/check-backlog-item.test.mjs, and 10–20 in we:docs/agent/backlog-workflow.md. This story does not receive `estimatedLoc`.
- **Overlap:** #4683 is still open and owns the whole-repository changed-card gate; this story implements the explicitly authorized per-item alternative. No prerequisite edge change is proposed.

## Design

In we:scripts/check-backlog-item.mjs, safely parse raw frontmatter for the selected item and add an error when `kind: decision` and `status: resolved` lack valid scalar `codifiedIn`. Reuse `validateCodifiedIn` from we:scripts/backlog/frontmatter.mjs after checking the value's type. Missing, null, empty, whitespace-only, numeric, boolean, sequence and mapping values fail. Nonblank strings must satisfy the existing validator; do not introduce a second grammar or array support. The diagnostic identifies the item and field and explains promotion to the statute layer or the existing `one-off` sentinel. Pointer target existence is not a new guarantee.

A failed YAML parse must retain the existing error-level diagnostic and exit 1, not fall through to a clean result or throw a second uncaught exception. Do not rely on the loader retaining `codifiedIn`. Preserve unresolved decisions, non-decisions, CLI arguments, directory precedence and the single-file limitations notice. This is selected-card validation, not Git diff detection: an explicitly selected legacy resolved decision is subject to the same rule. No automatic migration or whole-repository enforcement is introduced.

In we:docs/agent/backlog-workflow.md, immediately before “Mark it resolved — through the declared operation,” add a decision-resolution checklist: enumerate every Done-when clause; link the ruling/evidence satisfying it; identify each deferred obligation and its already-filed follow-up id; confirm codification separately. Apply it to both operation-driven and hand-authored resolutions. An uncovered clause must be completed or explicitly accounted for; an id alone does not prove delivery. Keep human judgment over whether the ruling satisfies the clauses.

## MVP

1. Add the selected resolved-decision guard and actionable failure output in we:scripts/check-backlog-item.mjs using the existing validator.
2. Extend we:scripts/__tests__/check-backlog-item.test.mjs with real subprocess regressions, the compatibility matrix and a narrow checklist-document contract test.
3. Add the resolve-time checklist to we:docs/agent/backlog-workflow.md and demonstrate its use against #4599 without inventing a missing ruling.

## Acceptance

Each named test below is planned in we:scripts/__tests__/check-backlog-item.test.mjs. The shared executable command is the host heavy-run queue invoking Vitest on that file (see Proof plan). Each new regression includes a missing-behavior assertion that fails against the pre-build source and passes after; compatibility rows within the same test must remain green throughout.

- [A1] Executable: test `resolved decision codification matrix` runs the checker against omitted/null/empty/whitespace and malformed scalar/sequence/mapping values, asserting exit 1 and an item-specific codification diagnostic; `one-off` and an existing-grammar pointer assert exit 0. Invalid nonblank strings fail under the shared grammar. This pins the changed default for selected legacy resolved decisions and the type-error fail-closed paths.
- [A2] Executable: test `codification guard preserves checker callers and eligibility` pairs an invalid resolved decision with open/active/preparing decisions and resolved non-decisions, exercising positional ids, `--item`, directory flag and environment selection. Only the invalid resolved decision fails; retain existing default-directory/missing-target tests and the single-file notice assertion. The invalid-decision assertion makes this regression red before implementation.
- [A3] Executable: test `malformed YAML and malformed codification fail without an uncaught exception` checks malformed YAML and a parsed mapping-valued codification independently: both exit 1 with the relevant diagnostic and neither emits an uncaught TypeError/stack trace. The mapping case fails the pre-build checker. Error text points to correcting YAML or supplying valid codification; there is no bypass fallback.
- [A4] Executable: test `decision resolution checklist precedes the resolve instruction` reads we:docs/agent/backlog-workflow.md and asserts that the decision checklist occurs before the resolve step and explicitly includes every Done-when clause, ruling/evidence links, already-filed follow-up ids with remaining obligations, separate codification, and applicability to hand edits and the operation. This document contract fails before the checklist is added; it does not pretend to evaluate the semantic adequacy of a ruling.

## Test plan

Use the existing subprocess harness and temporary directory lifecycle in we:scripts/__tests__/check-backlog-item.test.mjs. Parameterize fixture frontmatter without weakening existing assertions. Keep fixtures otherwise valid so unrelated lint failures cannot satisfy a regression. Assert exact exit status plus the relevant diagnostic, including absence of uncaught exceptions. Preserve the suite's real-backlog non-mutation assertion.

Implement A1–A4 as named tests; A1 covers all invalid YAML value types and valid scalar controls, A2 covers caller and eligibility compatibility, A3 covers parse/type failures, and A4 checks the authored workflow contract. Read the document relative to the repository root. No resolve operation should run against a real card. Source/test pair: we:scripts/check-backlog-item.mjs and we:docs/agent/backlog-workflow.md → we:scripts/__tests__/check-backlog-item.test.mjs.

## Proof plan

Before implementation, add A1–A4 and run the focused test file through the host heavy-run queue. Record the expected failing assertions (missing codification rejection and missing checklist). Implement the scoped changes and rerun the same file, recording exit-code/diagnostic evidence and all compatibility controls. Commands below are expressed with repository-prefixed paths for this card; when executing from WE, strip the `we:` locus marker from path arguments:

- `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npx vitest run we:scripts/__tests__/check-backlog-item.test.mjs`
- `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npm run check:standards`
- Runner per-item check: `npm run check:item -- 4611`.

If admission remains busy after the single bounded wait, stop and report the unrun check; do not poll. The runner owns preparation stamping and its checks. This preparation changes only the card, not the implementation or tests.

Manually walk #4599's Done-when at we:backlog/4599-define-human-forge-edits-and-durable-acknowledgements-at-the.md:33 against its ruling at line 37. Account separately for the human-label rule, durable command acknowledgement boundary, #3216 hand-off, conformance vectors and codification. The visible ruling describes label/command handling and projection receipts but is not evidence that every other obligation is fulfilled. Record missing evidence honestly; do not supply a new decision or claim an unfiled follow-up exists. The automated document test establishes checklist presence, while this walkthrough demonstrates its use.

## Follow-ups

- #4683 owns whole-repository changed-card enforcement. Align with its semantics when integrating; this per-item checker alone cannot guarantee every hand edit runs through CI.
- #2846 tracks array support; this MVP uses the existing scalar validator and does not extend that contract.
- Substantive completion/codification of #4599 remains outside this implementation. Missing rulings need the decision authority; no repair is claimed filed or delivered here.
- Automatic semantic evaluation of Done-when prose, new resolve arguments and legacy-pool migration remain outside this MVP. The authorized checklist supplies the second prevention guard.
