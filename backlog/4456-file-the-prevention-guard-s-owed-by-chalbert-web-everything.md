---
bornAs: xyusi8m
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-retired-fields.test.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards-backlog-schema.test.mjs", "we:backlog/1683-implement-the-js-first-token-runtime-webinjectors-resolves-t.md"]
dateOpened: "2026-09-28"
preparedDate: "2026-11-01"
preparedAgainstSha: "7a8f51570435bc14cb2e13114cb1c7484119daf4"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2871's independent review

Close the remaining frontmatter-prevention debt from #2871: reject the retired `workItem` field using the canonical `kind` schema. Add a raw-frontmatter standards guard, regression coverage, and remove the redundant legacy field from the one remaining card. Epic sizing is excluded by the recorded operator ruling.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2871@4fc1a8ca300c9f3e20d92ae2ed704339ef026ff2

## Progress

- Original premise/scope: require childless-epic points and reverse the classification migration; the original touch set named only the two reviewed provenance cards. The previous preparation corrected the canonical axis but retained conflicting epic-size requirements, broad test paths, and a proposal to run the old migration script.
- Recorded operator ruling (2026-10-13): drop the epic-size guard and retain only the `workItem` guard. This preparation applies that ruling consistently; no sizing policy is being chosen or changed.
- Current evidence: we:scripts/check-standards-rules.mjs:505 already requires `kind`, and we:scripts/check-standards-rules.mjs:516 rejects invalid values. Searching both standards source files finds no authored-`workItem` rejection. The raw parse seam is now we:scripts/check-standards.mjs:1060 (previously cited as line 1039); its scope-absent early exit at we:scripts/check-standards.mjs:1067 makes placement before that exit essential. Malformed YAML is independently reported at we:scripts/check-standards.mjs:1000.
- Corpus correction: the remaining occurrence is we:backlog/1683-implement-the-js-first-token-runtime-webinjectors-resolves-t.md:3, immediately after canonical `kind: epic` on line 2. It is resolved, so the new guard must cover resolved cards too. Remove only its redundant field during implementation. Do not run we:scripts/backlog/migrate-kind.mjs:70: its anchor/drop logic retains an existing `kind` line while emitting another, creating duplicate keys for this mixed-field input.
- Corrected scope: two validator sources, two planned matching regression files, and that one corpus repair. Existing we:scripts/__tests__/check-standards-frontmatter-parse.test.mjs:5 and we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs:34 remain unchanged compatibility checks. The disposable real-gate pattern exists at we:scripts/__tests__/check-standards.test.mjs:639; the new integration file is not yet present.
- Size remains 3: approximately 20–35 changed lines in the pure rule, 10–20 in gate wiring, 70–100 in pure regressions, 100–150 in disposable gate regressions, and one removed corpus line (five-file touch set, about 201–306 lines). Integration setup and full/local gate coverage dominate the estimate. This is a story; no estimatedLoc is added. Preparation stamps are left to the runner. No implementation or passing regression is claimed.

## Design

Add a pure retired-field validator in we:scripts/check-standards-rules.mjs accepting parsed raw frontmatter. Detect own-key presence of `workItem`, regardless of value or accompanying `kind`. Emit an error with the card path, field, and a stable `backlog-retired-field` descriptor; explain that the author must retain or supply canonical `kind` and remove `workItem`. Do not infer a new classification from conflicting fields.

Wire it into the existing raw-frontmatter loop in we:scripts/check-standards.mjs before any scope-related early return. Apply to all successfully parsed cards, including resolved cards and cards without scope, consistent with that loop's existing full-collection behavior even under local mode. Keep existing required-kind/enum checks and parse-error reporting. Malformed YAML must still fail the gate rather than being treated as evidence of valid schema; unreadable files must not silently become a clean retired-field result. Avoid adding another catch-and-continue read path.

The changed default is that previously tolerated `workItem` now fails standards validation. Remove only that field from we:backlog/1683-implement-the-js-first-token-runtime-webinjectors-resolves-t.md. Preserve its canonical classification and all other content. No new runtime settings, parser, epic sizing rule, or broad obsolete-field policy is introduced.

## MVP

1. Reject authored `workItem` for legacy-only and mixed-field cards, including empty/null/false values and resolved cards, with an actionable named error.
2. Call the rule from the real standards gate before scope filtering; preserve canonical-kind and malformed-YAML failures.
3. Remove the known redundant corpus field and add isolated pure and real-gate regression fixtures. Production cards are never mutated by tests.

## Acceptance

- [A1] Executable — planned `rejects every authored workItem value` test in we:scripts/__tests__/check-standards-rules-retired-fields.test.mjs fails against the old validator and passes with the guard. Table cases cover legacy-only, mixed fields, null, empty string, false, object, and resolved status; paired canonical-only controls stay clean.
- [A2] Executable — planned `enforces retired fields before scope exits in full and local gates` test in we:scripts/__tests__/check-standards-backlog-schema.test.mjs fails before wiring and passes after. Real CLI runs cover a scope-less resolved card and a scoped open card, assert nonzero exit plus `backlog-retired-field` and the fixture path, then remove only the legacy key and assert that finding disappears. Include an unselected legacy card in local mode to pin the existing collection-wide loop behavior.
- [A3] Executable — planned `legacy rejection preserves classification and parse failures` test in we:scripts/__tests__/check-standards-backlog-schema.test.mjs fails before the guard because mixed-field rejection is absent, and passes after. In the same regression matrix, missing/invalid kind and malformed YAML retain their specific failures; duplicate-key input remains a parse failure. This pins fail-closed parsing and the unchanged callers' diagnostics together with the new guarantee.
- [A4] Executable — planned `canonical corpus card has no retired field` test in we:scripts/__tests__/check-standards-backlog-schema.test.mjs parses we:backlog/1683-implement-the-js-first-token-runtime-webinjectors-resolves-t.md and asserts exactly one `kind: epic`, absent own `workItem`, and resolved status. It fails on the current card and passes after the one-line migration.

## Test plan

Implement the named A1–A4 tests in the two new scoped files. Use the disposable checkout approach from we:scripts/__tests__/check-standards.test.mjs; copy the working validator sources into the checkout so tests exercise uncommitted implementation rather than only HEAD. Use task-provided temporary storage, bounded child-process output/timeouts, and cleanup in finally. Run actual gate producers, not source-text matching or fabricated diagnostics. Keep fixture runs sequential under the outer heavy admission.

Run the two new suites plus unchanged we:scripts/__tests__/check-standards-frontmatter-parse.test.mjs and we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs through we:scripts/readiness/heavy-admission.mjs using its `run --wait-ms=60000 --` arguments followed by `npx vitest run` and those paths with the `we:` locus stripped at execution. Then run `npm run check:standards` through the same queue. Wait once if busy and report the queue outcome; do not poll. The runner owns preparation-time checks; these are build acceptance commands.

## Proof plan

Save red/green output for A1–A4 using the added tests first with the pre-build sources/corpus and then with the implementation. Prove wiring by removing only the new gate call in a disposable checkout: A2 must fail while pure A1 remains green. Restore it and record passing focused results. For each real-gate fixture retain argv, exit status, card text, and the specific diagnostic before/after correction. A nonzero exit alone proves nothing; unrelated baseline findings must be reported separately. Record the queued standards result and confirm the final implementation diff touches only its declared scope.

## Follow-ups

- Epic sizing is outside this item under the recorded ruling; do not file speculative sizing cleanup as a condition of completion.
- Broader retired-field policy, scoped-linter parity, and repair of the old migration utility are separate work. This implementation uses a one-line corpus edit and does not depend on that utility.
- Report any newly discovered corpus occurrences for explicit scope adjustment; do not silently migrate unrelated cards or choose their classifications.
