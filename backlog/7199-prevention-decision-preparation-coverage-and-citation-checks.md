---
bornAs: xezensp
kind: story
size: 3
parent: "4075"
status: open
dateOpened: "2026-10-25"
tags: []
---

# Prevention: decision preparation coverage and citation checks from PR 5932

Track the six prevention guards requested by the 2026-10-25 review of decision #4010: caller-symbol citations, guarantee-to-test mappings, two-subject isolation, activation persistence, dependency-safe acceptance and corrupt scheduled-job state. Reuse the existing guarantee gate work in #5473 and citation checks in #3528.

## Review provenance

Filed for all ten findings in the 2026-10-25T20:52:09Z changes-requested review of web-everything/web-everything#5932. The repeated isolation and activation findings share guards below. This is tracked prevention work, not a claim that the checks already run. Coordinate guarantee checks with #5473 and symbol resolution with #3528 rather than introducing parallel validators.

Extended for all seven findings in the 2026-10-26T03:32:08Z review of web-everything/web-everything#5953. Keep this numbered card (`bornAs: xezensp`) as the sole owner; the refresh removes its duplicate hash-named file. Items 2 and 7 file the additional owed prevention: per-claim coverage (including this card's own acceptance and edge cases) and rejection of reintroduced card identities. These extend the existing work, not separate validators.

## Done when

All cases below are **planned**, including cases in files that already exist. A repository-qualified name is an implementation target, not evidence that it runs today.

1. **Caller citations (correctness 1):** extend #3528 to resolve each caller path:line to the imported/called symbol, including aliases.
   - Planned `we:scripts/lib/__tests__/citation-check.test.mjs::caller-citation-matches-imported-symbol` accepts `liveStatusFor as liveProbationStatusFor` and rejects citing that import as `statusFor`.
   - Planned `we:scripts/lib/__tests__/citation-check.test.mjs::unresolvable-source-is-visible` has separate missing-file, stale-line, unreadable-file and truncated-read cases; each asserts a visible unresolved finding naming its citation, never a pass.
   - Planned `we:scripts/lib/__tests__/citation-check.test.mjs::citation-identity-components-resolve-independently` changes repository, symbol and alias one at a time and asserts rejection of a wrong component even when the others match.
   - Planned `we:scripts/lib/__tests__/citation-check.test.mjs::card-text-is-never-executed` feeds executable-looking citation text and asserts no execution sentinel is created.
2. **Guarantee manifest (correctness 3, security 1, simplicity 1–2, codex-correctness 1–2):** extend #5473's preparation gate in `npm run check:standards`. Enumerate every normative behavioral claim, splitting compound sentences into individual obligations, including this card's own Done when (especially item 6), Risks, Non-goals and Edge cases. Require a mapping per obligation to repository-qualified test file, exact case named in Done when, and observable assertion. Independently persisted activation fields need distinct assertions. Semantic review still checks assertion adequacy; a matching name alone proves no behavior.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::unmapped-normative-guarantee-blocks-readiness` omits each obligation's mapping separately, including a clause in a compound sentence, and asserts not-ready with the missing obligation ID; complete mappings pass.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::explicitly-untested-guarantee-blocks-readiness` marks an otherwise mapped claim untested and asserts not-ready with that claim ID.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::self-referential-done-when-requires-named-cases` uses this card as an authoring fixture, removes each item 6 obligation's mapping separately and asserts not-ready even with items 1–5 fully mapped.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::normative-section-omission-blocks-readiness` parameterizes Done when, Risks, Non-goals and Edge cases with an unmapped behavioral claim in each; assert not-ready naming the claim and section, and accept the complete mappings. Recognize Test plan as their coverage index rather than requiring those headings to be renamed.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::edge-coverage-reference-requires-matching-case` separately omits an edge case's test ID, cites a case absent from the referenced Done-when item, and omits its assertion; each is not-ready, while a complete mapping passes.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::test-reference-components-resolve-independently` rejects wrong repository, file and exact case independently, even when other components match.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::manifest-text-is-never-executed` feeds executable-looking manifest text and asserts no execution sentinel is created. Both inert-text cases exercise newlines, CR/U+2028, backticks, quotes, leading `--`, path `..`, Unicode/invisible characters and concatenated text as data.
3. **Failure isolation (correctness 2, simplicity 1, codex-correctness 1):** require a two-subject fixture with failed and completed outcome assertions for continue/unrelated/isolated claims. Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::isolation-guarantee-requires-two-subject-assertions` rejects failed-only and completed-only mappings independently; accepts both outcomes in either subject order.
4. **Dependency-safe acceptance (correctness 4):** refuse landing acceptance requiring an open/blocked producer or a blockedBy cycle. Require an executable independent fixture at the earlier boundary, or keep acceptance explicitly pending with its later owner; never count pending integration as passed. Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::landing-acceptance-cannot-require-open-dependent-producer` separately rejects open, blocked and cyclic dependencies, rejects a dependency hidden in prose, and accepts #4010's independent watcher fixture while asserting #4011 real-planner integration remains pending.
5. **Persistent scheduled-job state (security 2):** require each persistent job input to name corrupt/missing/stale-state cases and visible refusal or bounded reconciliation/rebuild behavior. Reuse an existing shared job-record reader that refuses corruption; the authoring check itself reads inputs without changing scheduled-job state.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::persistent-job-input-requires-corruption-behavior` rejects cursor-only, receipt-only and no-corruption-test mappings. Parameterize cursor/receipt × corrupt/missing/stale, omitting one mapping per negative fixture; complete mappings pass, including visible refusal for a valid-looking receipt with no backing card.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::shared-job-record-reader-is-reused` exercises the validator's production entry with an injected shared reader, asserts that reader is called for each job-record input, and that its corruption refusal is preserved without a permissive fallback parser.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::authoring-check-preserves-scheduled-job-state` runs the production authoring entry for valid, invalid and hostile citation/manifest fixtures against a temporary job-state tree; assert identical file inventory and bytes (cursor, receipt, lock and scheduler records), with no write/create/delete calls, after each run, including read-error paths.
6. **Executable gate:** run the affected files through the command below, then `npm run check:standards`. Use pre-repair #4010 and its repaired form as negative/positive authoring fixtures.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::activation-field-omission-blocks-readiness` parameterizes event ID, event time, baseline start, baseline end, baseline digest, revision, commit binding and deadline. Omit exactly one assertion per fixture while retaining every other assertion; deadline remains present in every non-deadline omission fixture. Assert not-ready naming the omitted field. Also reject a deadline-only mapping; accept the complete mapping.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::each-negative-fixture-detects-its-disabled-rule` drives a mutation harness over every rejection rule in items 1–7, disabling one rule per isolated run. Assert its corresponding negative fixture fails and the repaired positive fixture still passes; require a row per rule and fail on any unexercised mutation. The production gate has no rule-disable option.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::authoring-fixtures-report-specific-findings` asserts pre-repair #4010 fails with the unmapped obligation/bad citation ID rather than a generic parse error, and its repaired form passes through the standards entry point.
   - Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::preparation-coverage-is-wired-into-standards` invokes the standards entry point on an invalid fixture tree and asserts nonzero status with the obligation ID; its complete counterpart exits zero.
7. **Duplicate identity prevention (#5953):** extend the existing duplicate-card write/standards guard to reject a new unnumbered card whose leading slug matches an existing `bornAs`, or whose title matches an existing card's title. Report the existing path and require editing that card instead. Planned `we:scripts/lib/__tests__/duplicate-bornas-added.test.mjs::unnumbered-card-identity-collision-blocks-write` covers slug-only and title-only collisions separately (including this hash file versus #7199), asserts refusal and the existing path through the write/standards entry, and accepts an in-place #7199 update and an unrelated new card. Planned `we:scripts/lib/__tests__/duplicate-bornas-added.test.mjs::same-batch-card-identity-collision-blocks-write` adds two colliding cards in one batch (same birth slug or same title), asserts refusal naming both paths in either order, and accepts a batch of distinct cards.

Implementation verification for Done when 6:

```sh
npm run test:unit -- scripts/lib/__tests__/citation-check.test.mjs scripts/lib/__tests__/prepare-forks.test.mjs scripts/lib/__tests__/duplicate-bornas-added.test.mjs
```

## Non-goals

- No probation runtime implementation, enrollment, ratification, watcher installation or policy change. No cryptographic receipt tamper detection; this card covers accidental corruption and inconsistent persisted claims. No replacement for semantic review of the named assertions.

## Edge cases this change must handle

1. **Untrusted text** — parse citations and manifests as data; no executable card text. Covered by Done when 1: `we:scripts/lib/__tests__/citation-check.test.mjs::card-text-is-never-executed`; 2: `we:scripts/lib/__tests__/prepare-forks.test.mjs::manifest-text-is-never-executed` (no execution sentinels).
2. **Truncated reads** — missing/unreadable/truncated sources and stale lines stay visibly unresolved. Covered by Done when 1: `we:scripts/lib/__tests__/citation-check.test.mjs::unresolvable-source-is-visible` (citation-specific unresolved findings).
3. **Shared state files** — validation preserves scheduled-job state and reuses its reader. Covered by Done when 5: `we:scripts/lib/__tests__/prepare-forks.test.mjs::authoring-check-preserves-scheduled-job-state` (unchanged inventory/bytes and no writes) and `we:scripts/lib/__tests__/prepare-forks.test.mjs::shared-job-record-reader-is-reused` (reader calls and preserved refusal).
4. **Fail closed** — omitted or explicitly untested obligations block readiness. Covered by Done when 2: `we:scripts/lib/__tests__/prepare-forks.test.mjs::unmapped-normative-guarantee-blocks-readiness` and `we:scripts/lib/__tests__/prepare-forks.test.mjs::explicitly-untested-guarantee-blocks-readiness` (not-ready with the obligation ID).
5. **Identity scoping** — resolve repository, symbol, alias, file and exact case independently. Covered by Done when 1: `we:scripts/lib/__tests__/citation-check.test.mjs::citation-identity-components-resolve-independently`; 2: `we:scripts/lib/__tests__/prepare-forks.test.mjs::test-reference-components-resolve-independently` (wrong-component rejection); 7: `we:scripts/lib/__tests__/duplicate-bornas-added.test.mjs::unnumbered-card-identity-collision-blocks-write` (no second card).
6. **State over time** — stale citations, independent activation fields and producer dependencies need separate assertions. Covered by Done when 1: `we:scripts/lib/__tests__/citation-check.test.mjs::unresolvable-source-is-visible`; 6: `we:scripts/lib/__tests__/prepare-forks.test.mjs::activation-field-omission-blocks-readiness`; 4: `we:scripts/lib/__tests__/prepare-forks.test.mjs::landing-acceptance-cannot-require-open-dependent-producer` (separate stale/field/dependency refusal).
7. **Who wrote it** — n/a: this is a read-only authoring check; it grants no operator authority or trusted authorship.

## Risks

- **R1: fail-open evidence** — unreadable citations or partial mappings could look complete. Test plan T1–T2.
- **R2: executable text or state writes** — parsing author text could execute it or alter job records; a new parser could bypass a shared reader's refusal. Test plan T3.
- **R3: bundled promises** — one mapped deadline could conceal other activation fields, or self-referential and edge-case promises could escape coverage. Test plan T2 and T4.
- **R4: structural coverage mistaken for semantic proof** — valid names cannot establish assertion adequacy. Test plan T2 checks mapping structure; semantic review inspects each named assertion before readiness. This review is a human obligation, not an automated semantic-proof claim.
- **R5: duplicated work or premature acceptance** — duplicate identities, one-subject fixtures and open producers could double-count work or overstate completion. Test plan T5.

## Test plan

These are planned implementation checks, mapped to the exact repository-qualified cases and observable assertions in Done when; none is claimed executed by this authoring refresh.

| Plan / risks | Done when / exact planned cases | Observable assertion |
| --- | --- | --- |
| T1 / R1 | 1: `caller-citation-matches-imported-symbol`, `unresolvable-source-is-visible`, `citation-identity-components-resolve-independently` | Correct alias accepted; wrong identity and each source failure visibly unresolved. |
| T2 / R1, R3, R4 | 2: `unmapped-normative-guarantee-blocks-readiness`, `explicitly-untested-guarantee-blocks-readiness`, `self-referential-done-when-requires-named-cases`, `normative-section-omission-blocks-readiness`, `edge-coverage-reference-requires-matching-case`, `test-reference-components-resolve-independently` | Each separately omitted clause, missing/wrong test reference or untested claim is not-ready; complete structure passes. Semantic review checks adequacy. |
| T3 / R2 | 1: `card-text-is-never-executed`; 2: `manifest-text-is-never-executed`; 5: `authoring-check-preserves-scheduled-job-state`, `shared-job-record-reader-is-reused`, `persistent-job-input-requires-corruption-behavior` | Hostile text stays inert; state inventory/bytes unchanged; shared reader invoked and refuses corruption; every state/input mapping required. |
| T4 / R3 | 6: `activation-field-omission-blocks-readiness`, `each-negative-fixture-detects-its-disabled-rule`, `authoring-fixtures-report-specific-findings`, `preparation-coverage-is-wired-into-standards` | Each field omission rejected; each rule's mutation kills its negative fixture; specific diagnostics and standards exit status agree. |
| T5 / R5 | 3: `isolation-guarantee-requires-two-subject-assertions`; 4: `landing-acceptance-cannot-require-open-dependent-producer`; 7: `unnumbered-card-identity-collision-blocks-write`, `same-batch-card-identity-collision-blocks-write` | Require both subject outcomes; refuse premature acceptance/cycles; reject duplicate slug or title against existing cards or within a batch, and allow the existing card update. |
