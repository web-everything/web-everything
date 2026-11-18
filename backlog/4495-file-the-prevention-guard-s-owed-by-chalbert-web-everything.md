---
bornAs: x0eudv8
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs", "we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs", "we:scripts/__tests__/check-backlog-item.test.mjs", "we:scripts/__tests__/tests-first.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "8bdc1a1b971bb29f2725c31c27fd5792d1682556"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2949's independent review

Prevent unfinished acceptance criteria from passing `check:standards`. The approval review requested a hard guard against `TODO:` placeholders under `## Done when`, plus frontmatter validation. The latter must preserve today's canonical `kind` contract, not restore the retired `workItem` field.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2949@09d945ceed5c52787823562755d17505d37a4732

## Progress

- Original premise/scope: duplicate findings cited lines 21/23 and line 2 of `we:backlog/4492-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md` and `we:backlog/4493-approval-time-prevention-filing-works-from-any-cwd-and-lands.md`, proposing placeholder rejection and mandatory `workItem` with rejection of `kind`. Those cards were the entire scope, despite the requested change belonging to the standards gate.
- Historical premise (2026-10-01): #4492 still contains an unfinished acceptance criterion; #4493 is resolved and now has concrete acceptance criteria, so its old line citations are historical review evidence, not current defect locations. `we:scripts/check-standards-rules.mjs` documents the merged axis beside `BACKLOG_KINDS`; `validateBacklogItem` already requires `kind` and rejects unknown kind values. The canonical workflow is described in `we:docs/agent/backlog-workflow.md`. Requiring `workItem` or rejecting `kind` would regress the existing contract.
- Observed on 2026-10-01: a direct Node import of `lintBacklogItemRendering` accepted the original placeholder criterion with zero errors and warnings. A minimal valid story passed `validateBacklogItem`; replacing its `kind` with `workItem: story` produced a missing-required-field error for `kind`. This item is therefore not already delivered: the placeholder guard remains missing.
- Corrected scope: implement the body guard in `we:scripts/check-standards-rules.mjs`, with matching coverage in existing `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` and `we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs`, plus CLI coverage in existing `we:scripts/__tests__/check-backlog-item.test.mjs`. Both `we:scripts/check-standards.mjs` (backlog rendering loop) and `we:scripts/check-backlog-item.mjs` already consume `lintBacklogItemRendering` errors; no new production wiring is required. The cited cards are evidence, not implementation targets.
- Drift re-check 2026-10-09: main now carries a narrower #4738 guard in `we:scripts/check-standards-rules.mjs:1187` (`hasUnfinishedAcceptanceBesideProofClaim`, called at `:1283`). It fires only for `status: open` AND only when the prose also claims "mutation proof", matching just `TODO: a command` (`:1184`). It already has a fence-aware, section-bounded scan (`:1187-1201`) and tests at `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs:895-946`. Not already delivered: a bare placeholder with no claim, or on a resolved card, is accepted (test row `placeholder, no claim` expects 0). This item widens that guard (any status, no claim needed, literal `TODO:`), so build by reusing/generalizing the #4738 scanner, not adding a second one. Corpus probe: ~10 backlog cards still contain `TODO: a command` (e.g. #3167, #3223, #3166), so the full gate will go red on them; see Proof plan.

- Re-preparation 2026-11-18: the old scope omitted a changed caller contract. The scanner now lives at `we:scripts/check-standards-rules.mjs:1352`; its regex at `we:scripts/check-standards-rules.mjs:1349` still only matches the scaffold phrase, strips inline code, and coerces absent bodies to empty strings. In addition to the claim-gated check at `we:scripts/check-standards-rules.mjs:1453`, a prepared/open/policy-gated check now calls the same scanner with `requireClaim = false` at `we:scripts/check-standards-rules.mjs:1447`. Thus the earlier claim that only proof-claim cards are rejected is obsolete. Bare literal placeholders, unprepared cards and resolved cards remain uncovered by these conditions; this is not already delivered.
- Corrected scope adds `we:scripts/__tests__/tests-first.test.mjs`: its lines 16–18 explicitly expect unprepared/resolved exemptions, and its line 65 expects the policy-off exemption. Those total-error assertions must deliberately change when the unconditional guard lands. Preserve the narrower diagnostics and policy behavior themselves. The original four scope entries remain necessary; no production caller edit is needed because errors already propagate at `we:scripts/check-backlog-item.mjs:100` and `we:scripts/check-standards.mjs:985`.
- Size remains 3: estimate roughly 55 changed lines in `we:scripts/check-standards-rules.mjs`, 110 in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, 25 in `we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs`, 35 in `we:scripts/__tests__/check-backlog-item.test.mjs`, and 25 in `we:scripts/__tests__/tests-first.test.mjs` (about 250 total). Canonical-kind validation already exists at `we:scripts/check-standards-rules.mjs:505` and `we:scripts/check-standards-rules.mjs:516`; this portion needs regression coverage, not a replacement schema. Prior corpus counts above are historical, not a current inventory. This preparation uses source inspection; runtime red/green evidence remains build work. Runner owns stamps and checks.

## Design

Generalize the existing fence-aware pass in `we:scripts/check-standards-rules.mjs:1352` into shared scanning that can collect one-based body line numbers for the literal, case-sensitive token `TODO:`. Retain the old case-insensitive scaffold-phrase and prose-claim results for both existing callers. Use the existing acceptance-heading matcher from `we:scripts/backlog/task-agreement.mjs:28`: both Acceptance and Done when sections, through subordinate headings until the next level-two heading or EOF. A level-one heading does not close the section. Skip backtick and tilde fenced blocks, including fake opening/closing headings inside them. For the new rule retain inline code, so backticking a placeholder cannot exempt it. Check subordinate heading text too; the existing claim detector may continue ignoring headings.

Add an unconditional hard rendering error for matching lines, regardless of kind, status, preparation stamp, proof claims or executable-acceptance policy. This extends the already-authored all-card requirement; the setting still controls its narrower prepared-card diagnostic, not the new literal-token guard. Keep the existing diagnostics identifiable, so their dedicated assertions retain meaning. The new diagnostic names the item id and distinct body line numbers and asks for concrete executable acceptance; it never echoes body text.

At entry to `lintBacklogItemRendering`, reject non-string bodies with a diagnostic and return before other detectors run. Null, undefined, arrays and objects must neither throw nor become empty successful evidence. Empty string is valid input with no section. No artificial size bound or truncation is introduced: scan the full supplied string. Both existing file-reading callers supply strings and propagate errors already. Preserve `validateBacklogItem`'s required canonical kind and membership validation; do not require retired workItem or ban unrelated metadata.

## MVP

1. Implement the shared scan, unconditional placeholder diagnostic and early invalid-body refusal in `we:scripts/check-standards-rules.mjs`.
2. Cover lexical boundaries and failure paths in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`; explicitly update changed exemption expectations in `we:scripts/__tests__/tests-first.test.mjs` while retaining policy-resolution coverage.
3. Add canonical-kind regression cases in `we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs` and isolated bad/good CLI fixtures in `we:scripts/__tests__/check-backlog-item.test.mjs`. No corpus edits belong in this touch set.

## Test plan

Use named tests prefixed `4495` for the new acceptance cases. Capability cases assert the new diagnostic, not an arbitrary nonzero error count. Preservation cases assert the absence of that diagnostic, alongside existing specific diagnostics where appropriate.

- `4495 rejects literal placeholders with exact lines`: both headings; all canonical kinds and statuses; prepared/unprepared; no claim; multiple hits/sections; inline code; subordinate headings and EOF. Include a unique untrusted sentinel beside the token and assert it never appears in diagnostics.
- `4495 preserves section and fence boundaries`: before/after-section mentions, valid criteria, lowercase non-literal spelling, both fence styles, longer fences and mismatched closing markers, fake section headings outside and fake closing headings inside fences. Mutation controls: remove fence tracking, remove section tracking, or strip inline spans; corresponding assertions must fail.
- `4495 refuses non-string bodies`: null, undefined, object and array return errors without throwing; empty string passes. Removing the early refusal must fail these tests.
- `4495 unconditional guard survives legacy exemptions`: update the existing unprepared/resolved and policy-off fixtures in `we:scripts/__tests__/tests-first.test.mjs` to require the new error and still assert absence of the policy-specific diagnostic where disabled. Prepared policy-on fixtures retain their old diagnostic too. Do not weaken those assertions into generic success. Existing #4738 tests that filter only their own diagnostic retain their meaning.
- `4495 canonical kind remains required`: valid story without workItem passes; missing/unknown kind and workItem-only fail. These are preservation tests, green before and after; removing required-kind or membership validation, or requiring workItem, must make them red.
- `4495 CLI rejects then accepts acceptance fixture`: reuse the temporary backlog and real CLI harness in `we:scripts/__tests__/check-backlog-item.test.mjs:15`; otherwise-identical unprepared bad/good cards exit 1/0 with the new diagnostic present/absent. Keep real backlog unchanged. Removing shared-lint error propagation must fail this test.

## Proof plan

Run only the four scoped suites through the host heavy queue. Command notation below uses repository-prefixed paths; strip the leading `we:` from each path argument when invoking from the WE root. Queue invocation: `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <suite paths>`. The suite paths are `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, `we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs`, `we:scripts/__tests__/check-backlog-item.test.mjs` and `we:scripts/__tests__/tests-first.test.mjs`. If busy, wait once using the queue's supported wait option, then report rather than poll.

First add the named capability tests and capture their expected failures against the base implementation; capture preservation tests passing. Then implement, run the same suites green and run the named mutation controls in an isolated task temporary directory, restoring each mutation. Canonical-kind preservation does not honestly have a pre-build defect: its executable red evidence is the validator mutation, not a fabricated baseline failure.

Runner performs preparation checks. At build time run the scoped and full standards gates through the same queue (`npm run check:standards -- --item 4495`, then `npm run check:standards` as the queued command). Inventory actual new diagnostic hits across `we:backlog/*.md` and record ids/lines; do not reuse the historical count. The CLI fixture supplies the controlled negative/positive executable proof; a full-gate failure alone is not proof of this guard. Report unrelated failures separately. Existing unfinished cards require substantive preparation before a green full-gate completion claim; do not invent criteria, mechanically delete placeholders or introduce status exemptions to clear the gate.

## Acceptance

- [A1] **Executable** — Run the queued content-lint suite's `4495 rejects literal placeholders with exact lines` and `4495 preserves section and fence boundaries` tests. New diagnostic assertions fail before implementation and pass after, proving section scope, literal matching, line reporting, safe diagnostics and fence/inline behavior. Boundary preservation tests must also fail under the named scanner mutations.
- [A2] **Executable** — Run the queued content-lint suite's `4495 refuses non-string bodies` test: rejection assertions fail before implementation and pass after, while empty strings remain accepted.
- [A3] **Executable** — Run the queued tests-first suite's `4495 unconditional guard survives legacy exemptions` test: new rejection assertions fail before and pass after for policy-off, unprepared and resolved fixtures, while the narrower diagnostics retain their existing conditions.
- [A4] **Executable** — Run the queued kind-axis suite's `4495 canonical kind remains required` test. It passes on base and build; required-kind/membership/remapping mutations fail before restoring the validator and pass after restoration. This is preservation proof for the already-delivered frontmatter guarantee.
- [A5] **Executable** — Run the queued single-item CLI suite's `4495 CLI rejects then accepts acceptance fixture` test: the bad fixture rejection fails on base and passes after implementation, the good fixture remains exit 0, and removing error propagation makes the test fail. Record the queued full standards gate result and corpus offenders before claiming completion.

## Follow-ups

Prepare corpus offenders separately with substantive executable criteria and their original goals. They are evidence to inventory, not permission to expand this card's implementation scope. Broader placeholder vocabularies, Unicode normalization, arbitrary frontmatter-key allowlisting and generator changes are outside this literal-token guard. No blocker-edge change is proposed without identifying and independently confirming the actual prerequisite card.
