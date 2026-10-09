---
bornAs: x88jhl9
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs", "we:scripts/__tests__/check-backlog-item.test.mjs", "we:docs/agent/delivery-loop.md", "we:docs/agent/conventions.md", "we:backlog/4304-run-rating-record-whether-an-item-was-prepared-dor-before-bu.md"]
dateOpened: "2026-09-27"
preparedDate: "2026-10-09"
preparedAgainstSha: "0c6c1fb5caf43602aeff444ed5731b4c39e1c1ec"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2828's independent review

Complete the prevention debt recorded on approval: reject repository-locus prefixes used as executable Node/Vitest file operands, and make one factual citation spot-check explicit in backlog-card review. Reuse the existing kind/size schema validation rather than reintroducing the retired `workItem` field.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2828@18ef1dcc16c31b13161df2b74be267e2e227e983

## Progress

- Original premise: four review debts (one citation-review habit, one command guard, and two duplicate requests for a `workItem`/story-size validator), scoped only to we:backlog/4305-configurable-combinable-delivery-and-testing-strategies-rout.md and we:backlog/4304-run-rating-record-whether-an-item-was-prepared-dor-before-bu.md.
- Corrected premise: `kind` replaced the historical classification fields. Required-field/enum validation already exists in we:scripts/check-standards-rules.mjs:367, and story-size enforcement in we:scripts/check-standards-rules.mjs:460; the live standards gate invokes that validator at we:scripts/check-standards.mjs:851. The duplicate schema requests therefore require no new validator or `workItem` migration.
- The command defect remains observable in we:backlog/4304-run-rating-record-whether-an-item-was-prepared-dor-before-bu.md:20 (Vitest) and we:backlog/4304-run-rating-record-whether-an-item-was-prepared-dor-before-bu.md:24 (Node). The old line-17 citation points to a blank line rather than the executable criterion. That card is now resolved; fixing its command spelling does not reopen its delivered feature.
- Corrected scope: the shared per-item lint in we:scripts/check-standards-rules.mjs:1219, its existing unit suite and scoped-CLI integration suite, conventions, the review procedure, and the affected #4304 command examples. Both consumers already call the shared lint (we:scripts/check-standards.mjs:964; we:scripts/check-backlog-item.mjs:100), so neither caller needs a production edit. #4305 is evidence provenance, not an implementation target; no delivery-strategy design is included.
- Existing author-side verification guidance at we:docs/agent/backlog-workflow.md:1216 does not replace the requested reviewer spot-check. Add the latter to we:docs/agent/delivery-loop.md. Size stays 3: one bounded lint, regression/integration fixtures, and documentation corrections. No dependency changes are proposed. Preparation is based on source inspection; no implementation or passing-test claim is made.

## Design

Extend `lintBacklogItemRendering` in we:scripts/check-standards-rules.mjs with a pure acceptance-command detector. Inspect inline command spans and shell/plain fenced command lines inside `## Done when` or `## Acceptance`, including subordinate headings. Detect a command beginning with Node or a Vitest invocation (direct, npx, or npm exec), including the command after a heavy-admission wrapper's `--`. Reject `we:` on the Node script operand or Vitest positional test-file operands; recognize options before those operands. Return a hard error naming the card, offending operand and the remedy: use a checkout-relative executable operand while preserving the repository-qualified citation in prose.

Do not classify arbitrary prose, source imports, quoted explanatory examples outside acceptance sections, or a Node inline program supplied through `-e`/`--eval` as file operands. Do not execute commands or rewrite text automatically. Apply the same rule to resolved cards: the reported regression itself lives in a resolved card. This is a bounded command-shape check, not a general shell parser.

Document the distinction in we:docs/agent/conventions.md: repository prefixes identify citations; executable operands resolve within the checkout. Repair #4304's acceptance commands using executable fenced examples with adjacent qualified source citations. Add the review habit to we:docs/agent/delivery-loop.md: for each new backlog/epic card, open one load-bearing file or PR citation, compare its factual claim with the source/diff, and record the citation and result in the review. A semantic truth check remains human review, not a regex guarantee.

## MVP

1. **Must:** add the shared hard-error command check in we:scripts/check-standards-rules.mjs, tested in we:scripts/__tests__/check-standards-rules-content-lint.test.mjs and through the real scoped CLI in we:scripts/__tests__/check-backlog-item.test.mjs.
2. **Must:** correct the executable acceptance examples in we:backlog/4304-run-rating-record-whether-an-item-was-prepared-dor-before-bu.md and explain executable operands versus citations in we:docs/agent/conventions.md.
3. **Must:** codify the one-citation review check in we:docs/agent/delivery-loop.md, retaining the existing kind/size validator unchanged.

## Test plan

- In we:scripts/__tests__/check-standards-rules-content-lint.test.mjs cover the two #4304 command shapes, Node options, Vitest options, admission wrappers, inline and fenced acceptance commands, subordinate headings, and resolved cards. Assert actionable hard errors, not warnings.
- Negative cases: checkout-relative executable operands, qualified prose citations, a command discussed outside acceptance sections, and Node eval strings containing a locus. Confirm acceptance-section boundaries prevent false positives.
- In we:scripts/__tests__/check-backlog-item.test.mjs use temporary backlog fixtures and the real scoped CLI: a bad operand exits nonzero; the corrected command with an adjacent qualified citation exits zero. This proves shared-lint wiring without editing production callers.
- Run both affected test files only through the host heavy-run queue. Existing kind-axis fixtures in we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs are the regression reference for already-delivered schema enforcement; no schema production changes are planned.

## Done when

1. **Executable (MVP 1):** the queued Vitest runs for the two named test suites pass, including a regression that fails before the new detector is installed and passes afterward. Run `npm run check:standards` only through the host heavy-run queue; the new rule must accept the corrected #4304 examples.
2. **Reviewable (MVP 2):** #4304 contains runnable checkout-relative operands and separate qualified citations; conventions explain why the spellings differ.
3. **Reviewable (MVP 3):** the review procedure names the minimum citation check and the evidence to record. Existing kind/size checks remain intact; no obsolete field is made required.

## Proof plan

Capture the queued regression failure before implementation and success after implementation. Temporarily disable only the new detector call: the invalid-command integration fixture must fail its expected nonzero-exit assertion; restore the call and rerun. Record commands, exit codes and fixture names. Run the queued standards gate and distinguish unrelated baseline findings from new-rule findings. Demonstrate the review habit on one real citation in this change and record the observed source/diff result; document presence alone does not prove factual correctness.

## Follow-ups

No general shell parser, delivery-strategy implementation, schema migration, or automatic factual-citation validator is included. If a corpus scan finds additional rejected commands, enumerate their exact cards and expand the implementation scope before changing them; do not weaken the rule or silently edit undeclared cards. Other repository aliases and additional executable tools can be separate evidence-driven extensions.
