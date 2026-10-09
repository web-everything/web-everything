---
bornAs: x0eudv8
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs", "we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs", "we:scripts/__tests__/check-backlog-item.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "dfe8b082a4e6a08541a3681e99d85b0db2b99e58"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2949's independent review

Prevent unfinished acceptance criteria from passing `check:standards`. The approval review requested a hard guard against `TODO:` placeholders under `## Done when`, plus frontmatter validation. The latter must preserve today's canonical `kind` contract, not restore the retired `workItem` field.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2949@09d945ceed5c52787823562755d17505d37a4732

## Progress

- Original premise/scope: duplicate findings cited lines 21/23 and line 2 of `we:backlog/4492-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md` and `we:backlog/4493-approval-time-prevention-filing-works-from-any-cwd-and-lands.md`, proposing placeholder rejection and mandatory `workItem` with rejection of `kind`. Those cards were the entire scope, despite the requested change belonging to the standards gate.
- Corrected premise: #4492 still contains an unfinished acceptance criterion; #4493 is resolved and now has concrete acceptance criteria, so its old line citations are historical review evidence, not current defect locations. `we:scripts/check-standards-rules.mjs` documents the merged axis beside `BACKLOG_KINDS`; `validateBacklogItem` already requires `kind` and rejects unknown kind values. The canonical workflow is described in `we:docs/agent/backlog-workflow.md`. Requiring `workItem` or rejecting `kind` would regress the existing contract.
- Observed on 2026-10-01: a direct Node import of `lintBacklogItemRendering` accepted the original placeholder criterion with zero errors and warnings. A minimal valid story passed `validateBacklogItem`; replacing its `kind` with `workItem: story` produced a missing-required-field error for `kind`. This item is therefore not already delivered: the placeholder guard remains missing.
- Corrected scope: implement the body guard in `we:scripts/check-standards-rules.mjs`, with matching coverage in existing `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` and `we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs`, plus CLI coverage in existing `we:scripts/__tests__/check-backlog-item.test.mjs`. Both `we:scripts/check-standards.mjs` (backlog rendering loop) and `we:scripts/check-backlog-item.mjs` already consume `lintBacklogItemRendering` errors; no new production wiring is required. The cited cards are evidence, not implementation targets.
- Drift re-check 2026-10-09: main now carries a narrower #4738 guard in `we:scripts/check-standards-rules.mjs:1187` (`hasUnfinishedAcceptanceBesideProofClaim`, called at `:1283`). It fires only for `status: open` AND only when the prose also claims "mutation proof", matching just `TODO: a command` (`:1184`). It already has a fence-aware, section-bounded scan (`:1187-1201`) and tests at `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs:895-946`. Not already delivered: a bare placeholder with no claim, or on a resolved card, is accepted (test row `placeholder, no claim` expects 0). This item widens that guard (any status, no claim needed, literal `TODO:`), so build by reusing/generalizing the #4738 scanner, not adding a second one. Corpus probe: ~10 backlog cards still contain `TODO: a command` (e.g. #3167, #3223, #3166), so the full gate will go red on them; see Proof plan.

## Design

Generalize the existing #4738 scanner (`we:scripts/check-standards-rules.mjs:1187`, already fence-aware and bounded by `ACCEPTANCE_HEADING_RE`) rather than writing a second one: factor out a section-placeholder finder that returns body line numbers, keep the #4738 claim-gated rule working unchanged, and extend `lintBacklogItemRendering` with a hard error for a literal `TODO:` inside a level-two acceptance section (`ACCEPTANCE_HEADING_RE`, so both `Done when` and the scaffold's `Acceptance`). Scan through subordinate headings until the next level-two heading or end of body, matching the existing scanner (a `# ` line does not end the section). Track fenced blocks so heading-like text inside a fence does not change section boundaries; a `TODO:` inside a fence is documentation, skipped, not an error. Inline code spans are NOT stripped for this rule (the #4738 scanner strips them, so the new finder takes a strip-spans option, off here, on for #4738), so a backticked `TODO:` is still a hit. Report the item id and body line of each hit, with an instruction to supply executable acceptance criteria.

Apply the check regardless of status or kind, matching the original request for any backlog card; do not silently grandfather resolved cards. Mentions outside the section are not acceptance placeholders. Reuse the existing shared lint entry point so the full gate and single-item check agree. Preserve the current frontmatter validation; add regression assertions for the canonical field instead of inventing a second schema or rejecting arbitrary metadata.

## MVP

1. Add the section-bounded hard error to `we:scripts/check-standards-rules.mjs`, exercised by `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`.
2. Pin acceptance of canonical `kind`, rejection of missing/unknown `kind`, and rejection of `workItem` as a substitute in `we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs`.
3. Prove the shared lint reaches the executable single-item gate using `we:scripts/__tests__/check-backlog-item.test.mjs`; retain existing full-gate error propagation.

## Test plan

- Capability (red today): the original generated acceptance criterion produces a hard error, with id and line, through `lintBacklogItemRendering`. Run it for both `## Done when` and `## Acceptance` headings. Cover open and resolved cards, multiple sections/hits, subordinate headings, EOF, a backticked inline `TODO:` (errors), and a fenced `TODO:` inside the section (does not error).
- Preservation (green today): valid criteria and mentions before/after the section remain accepted. Include a fenced fake section outside the real section and a fenced fake closing heading inside it. Mutation proof: remove section-boundary/fence tracking or scan the whole body; the negative cases must fail.
- Preservation (green today): valid `kind: story` without `workItem` passes; absent `kind`, unknown `kind`, and `workItem` alone fail. Mutation proof: remove the required-kind check or membership check, or require `workItem`; the corresponding assertions must fail.
- Capability (red today): CLI fixture containing the generated placeholder exits nonzero with the new diagnostic; the identical fixture with concrete criteria passes. Use the existing isolated-fixture conventions in `we:scripts/__tests__/check-backlog-item.test.mjs` and leave the live corpus untouched.

## Edge cases this change must handle

1. Untrusted text: card body is untrusted; the diagnostic must not echo body text, only item id and line numbers. NFKC/invisible-character variants of `TODO:` are out of scope (literal token only) and named in Follow-ups.
2. Truncated reads: n/a: the lint reads one in-memory body string; no `gh`/`git` read.
3. Shared state files: n/a: pure function, writes no state.
4. Fail closed: a null/undefined/unparseable body must not be treated as "no placeholder" silently for a card that has a `Done when` section; a non-string body is a lint error naming the refusal reason rather than coerced to an empty string; test null body errors and a genuinely empty string body (no section) passes.
5. Identity scoping: the diagnostic names the item id as the existing lint does; hash and NNN id spellings both appear via the same `id` the caller passes. n/a beyond that.
6. State over time: n/a: stateless; but resolved cards are linted too, so the corpus inventory must be rerun at build time, not trusted from this card.
7. Who wrote it: n/a: no trust is granted by the text.

## Proof plan

Run the targeted Vitest suites for the three scoped test files. Record the new capability cases failing against the base and passing after implementation; record preservation cases passing on both, plus the named mutation checks.

Exercise `npm run check:standards -- --item 4495` after implementation, and run the full `npm run check:standards` gate. For a negative control, use an isolated fixture checkout and restore the original generated placeholder in its copy of this card; observe a nonzero exit and this guard's diagnostic, then replace it with concrete criteria and observe that diagnostic disappear. Do not confuse unrelated baseline errors with proof of the new guard.

Inventory full-corpus hits before landing (probe: run the new finder over every `backlog/*.md` body, or `grep -n 'TODO:' backlog/*.md` filtered to acceptance sections, and record offending ids). Existing unfinished criteria (including #4492) may make the full gate red; record exact offending cards and arrange substantive acceptance-criteria preparation before claiming a green full gate. Do not erase placeholders mechanically, invent their acceptance commands, add a status exemption, or report the gate as passing while debt remains.

## Done when

- Must 1: the content-lint suite proves the placeholder diagnostic and its section boundaries, including all capability and preservation cases above.
- Must 2: the kind-axis suite proves the canonical frontmatter contract without requiring the retired field.
- Must 3: the single-item CLI suite proves nonzero/zero exits for otherwise identical bad/good acceptance fixtures; the full standards gate is run and its actual result recorded, with corpus blockers resolved before claiming completion.

## Follow-ups

Prepare any existing cards exposed by the new guard as separate, substantive backlog work, keeping their original goals. Broader placeholder vocabularies and arbitrary frontmatter-key allowlisting are outside this item's requested literal-token guard and existing canonical-kind contract. Changes to prevention-card generation, if the corpus probe identifies an ongoing producer, need their own source-and-test scope; this item does not silently expand into that workflow.
