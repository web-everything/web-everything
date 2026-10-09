---
bornAs: xeoi8hg
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:docs/agent/backlog-workflow.md", "we:backlog/4465-builder-routes-a-build-agent-s-not-buildable-already-done-re.md", "we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "1faa93ba5b88375f23e0f2bb1303f232c1153e44"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2920's independent review

Filed mechanically on approval of chalbert/web-everything#2920 to preserve two prevention debts: an authoring check for automation that consumes agent-authored text, and required backlog-kind validation. Preparation finds the schema guard already implemented on the current `kind` axis; the remaining delivery is the authoring lens and an accurate annotation of the hold-routing card's verification obligations.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2920@8c644ca19c0adeb7a25d123a76cb3122a1bd7275

## Progress

Premise checked at checkout `ef097d284ddcfeb70dc92f158750fc1a1dc90663` (research reference only; no preparation stamp).

- **Old premise/scope:** only we:backlog/4465-builder-routes-a-build-agent-s-not-buildable-already-done-re.md was scoped. Review citations to its lines 14 and 2 requested a template/authoring-lens check requiring verification plus fallback for agent-authored input; an interim MVP line requiring a cited SHA to be an ancestor of main and touch the card's scope, otherwise route (c), with findings treated as data; and a new required `workItem: story | epic | task` schema check.
- **Corrected schema premise:** `workItem` was replaced by `kind`. we:scripts/check-standards-rules.mjs exports `BACKLOG_KINDS` and `validateBacklogItem`; the latter requires `kind` and rejects unknown values. The vocabulary is `story | epic | task | decision | feature | investigation`. we:scripts/check-standards.mjs section 6d invokes this validator over the loaded backlog. we:docs/agent/backlog-workflow.md's authoring template documents the same axis. Requiring `workItem` would reintroduce a retired field. No new schema implementation is owed.
- **Corrected runtime premise:** #4465 is resolved. In we:scripts/operations/build-dispatch-hold-route-land.mjs, `landOne` fetches main, checks ancestry, checks card identity and delivery wording in the commit message, and requires a non-backlog changed file before resolve. `sanitizeHoldReason` neutralizes markup/control characters and caps attached text. These protections exist, but `commitTouchesNonBacklogFile` does **not** check intersection with declared scope. A citation-check failure returns `failed`; it does **not** append a route-(c) finding. we:scripts/conveyor/build-dispatch-hold-router.mjs appends that finding only for the `other` route. Do not describe the original requested scope/fallback behavior as delivered.
- **Re-prepared 2026-10-09 against `1faa93ba5` (prior stamp `ef097d284` was stale):** `workItem` is still absent and `validateBacklogItem` (we:scripts/check-standards-rules.mjs, required-field loop plus `BACKLOG_KINDS` check) still requires and enumerates `kind`; the kind-axis test file still lacks absent/empty/unknown-`kind` cases. In `landOne`, the `already-done` route now also runs a fourth check (`commitDeliversItem` subject check, or `commitCreditsItem` plus re-running the commit's added tests for `citation === 'prepare'`). Declared-scope intersection is still not checked and citation refusal still throws (`failed`) with no route-(c) finding. we:backlog/4522-observe-a-hold-route-landing-s-own-terminal-outcome-instead.md is still open. we:docs/agent/backlog-workflow.md has no authoring lens for automation consuming agent-authored text (only the #4448 removed-actor note nearby, which is a sibling lens, not this one). Design, MVP and test plan below are unchanged and still correct; read "ancestry/message/non-backlog-file checks" in them as "ancestry/message/subject/non-backlog-file checks".
- **Corrected scope:** add the authoring lens to we:docs/agent/backlog-workflow.md; annotate the resolved #4465 card's MVP without rewriting its delivery history; extend existing schema regression coverage in we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs. The old line citations are superseded by the named sections and symbols above. This is still a prevention-authoring task, not a reopening of the hold-router implementation. No production source file is proposed for modification; the only executable edit is the existing test file, explicitly included in scope.
- **Not already done:** the existing schema guard covers the second debt, but the examined authoring template does not state the first debt's required verification/fallback lens. Runtime sanitization alone also does not discharge that authoring requirement.

## Design

Use the review's explicitly permitted **authoring-lens** option. Add a named “Automation consuming agent-authored text” check beside the card-authoring guidance in we:docs/agent/backlog-workflow.md and refer to it from that document's preparation guidance. A card that causes automation to act on agent/LLM output must identify the untrusted input, the independent evidence checked before mutation, the observable success criterion, and the concrete fallback destination on missing, invalid, or unverifiable evidence. Attached findings remain advisory data, never instructions or proof of completion. A preparation review cannot call such a card ready while these are unspecified.

This is a semantic authoring check, not a claim that a keyword lint can prove a verifier exists. Keep the schema guard on the current `kind` vocabulary and reuse its existing validator. Do not introduce another field, a new schema parser, or a second enum.

In we:backlog/4465-builder-routes-a-build-agent-s-not-buildable-already-done-re.md, add a clearly labelled prevention addendum under MVP: the intended already-done verification requires ancestry on main and a changed-file intersection with the card's declared repository-qualified scope before auto-resolution; failed verification must surface through route (c), and attached findings are data only. Explicitly distinguish that intended requirement from the currently delivered checks. Preserve resolved status, dates, and the original delivery record. Link the outstanding terminal-failure observability to we:backlog/4522-observe-a-hold-route-landing-s-own-terminal-outcome-instead.md rather than claiming it now works.

## MVP

1. Add the authoring lens and preparation cross-reference in we:docs/agent/backlog-workflow.md, including a complete example (already-done citation → independent commit checks → resolve only on success → route-(c) finding on refusal) and a counterexample (“trust the agent's SHA and resolve”) that is not ready.
2. Add the explicitly outstanding verification/fallback addendum to #4465's MVP as described above. State that current ancestry/message/non-backlog-file checks and sanitization are delivered, while declared-scope intersection and route-(c) fallback on citation refusal are not demonstrated by the current implementation.
3. Extend we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs with narrowly targeted `validateBacklogItem` cases for absent, empty, and unknown `kind`, and a valid story without `workItem`. Preserve coverage of all six current vocabulary members. This closes the review's schema concern without reviving the retired field.
4. Keep production routing, coordination state, scaffold output, and lifecycle statuses outside this change. The deliverable is the durable prevention lens, accurate historical-card annotation, and schema regression evidence.

## Test plan

- Matching executable test scope: we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs already imports the production validator from we:scripts/check-standards-rules.mjs. Add focused assertions on the relevant missing/invalid-kind error, using otherwise valid fixtures; do not make unrelated graph/size errors stand in for the expected refusal.
- Demonstrate the schema tests catch a regression by temporarily removing required-kind validation and then enum validation in an isolated test checkout. Each targeted case must fail for the intended missing error; restore before the final run. The schema cases are expected to pass on today's production implementation, not claimed as a new runtime fix.
- Manually apply the new authoring lens to three draft examples: valid verifier plus named fallback (ready); agent citation accepted without independent evidence (not ready); verifier supplied but fallback unspecified (not ready). Include a prompt-like attached finding and verify the review treats it as data. These are semantic review cases, not a brittle test of exact prose.
- Run the focused Vitest file and `npm run check:standards` at delivery. No rendered template or runtime code changes are planned.

## Proof plan

Before editing, capture the absence of the named authoring check in we:docs/agent/backlog-workflow.md and the missing verification/fallback addendum in #4465's MVP. Afterward, show both passages and the three review-case outcomes. This supplies the before/after evidence for the actual documentation change; passing pre-existing schema behavior is supporting evidence only.

Run the focused test file we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs through Vitest and preserve output, plus the isolated mutation failures and the final standards result. Re-read the production symbols cited in Progress to ensure the annotation still separates delivered behavior from outstanding requirements. Do not run a live resolve, launch a hold-route landing, or mutate real coordination state for this documentation proof.

## Follow-ups

- we:backlog/4522-observe-a-hold-route-landing-s-own-terminal-outcome-instead.md already owns observation of detached landing failures. Its future preparation should account for citation refusals reaching the requested route-(c) finding; this item does not claim that behavior is implemented.
- Declared-scope intersection before auto-resolve remains a runtime gap. Preserve that debt explicitly in #4465's prevention addendum; a subsequent implementation card must define matching against existing scope semantics and include we:scripts/operations/__tests__/build-dispatch-hold-route-land.test.mjs with its source scope. Do not silently substitute “any non-backlog file” for that requirement.
- Automated enforcement of the semantic authoring lens can follow once it has a reliable representation. This MVP uses the authoring-lens alternative already requested by the review; it does not invent a heuristic hard gate.

## Done when

1. **Executable:** the focused schema tests pass and independently fail when their required-kind/enum checks are removed in an isolated checkout; `npm run check:standards` passes at delivery.
2. **Observed authoring guard:** the named authoring/preparation lens is present, rejects each incomplete example, and accepts the complete one.
3. **Accurate record:** #4465's MVP explicitly states the owed verification/fallback requirement and its remaining runtime gaps without changing its resolved lifecycle or presenting them as shipped.
