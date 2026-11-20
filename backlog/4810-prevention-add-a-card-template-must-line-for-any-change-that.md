---
bornAs: xfc0tcf
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/backlog/scaffold.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs", "we:scripts/backlog/__tests__/scaffold.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "cb057cf7c6104547c15892aed25af90cb14d8219"
tags: []
---

# Prevention — Add a card-template Must line for any change that tightens a verdict on an externally sourced set. It s… (from chalbert/web-everything#3424 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4958-a-cancelled-required-check-still-strands-a-pr-in-awaiting-ci.md` — Add a card-template Must line for any change that tightens a verdict on an externally sourced set. It should require one test per provenance value (`live`/`cache`/`stale-cache`/`fallback`). A lens check that greps for `source:` handling would also catch it.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3424@641b380b6bbe21000b084ea18581cf9f60ca3b17

## Acceptance

Each named test below is a required new capability case, selected by `4810`, which must fail on the pre-build implementation and pass after implementation. Commands are in Proof plan; these are planned tests, not claimed results.

- [A1] **Executable** — Must 1: test `4810 missing and partial provenance matrix` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` asserts four ordered gaps for no values, one gap for each individually omitted value, and no gaps for all four. The Must hint requires one test per `live`, `cache`, `stale-cache`, and `fallback` provenance.
- [A2] **Executable** — Must 1: test `4810 exact tokens and scan boundaries` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` proves `stale-cache` cannot satisfy `cache`, fenced values and post-boundary values cannot close gaps, and independent sentences cannot combine into a trigger. It covers empty/null input and non-triggering prose without throwing.
- [A3] **Executable** — Must 2: test `4810 warning integration status and kind matrix` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` verifies one warning listing missing values for non-resolved cards, no added errors, and silence for resolved cards; source/docs/config/data scope and story/task kinds receive the same treatment. Unknown status retains the existing non-resolved warning behavior.
- [A4] **Executable** — Must 3: test `4810 scaffold hint placement and wording` in `we:scripts/backlog/__tests__/scaffold.test.mjs` pins the new hint exactly once after the old hint in Acceptance and before Non-goals. Test `4810 scaffold defaults cannot supply evidence` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` runs actual `renderItem` output through the lint: tightening digest still warns for all four values, unrelated digest stays silent, and author-supplied coverage clears the warning. A historical body without the new hint is checked too.

## Progress

Re-preparation, 2026-11-20, against lane HEAD `cb057cf7c6104547c15892aed25af90cb14d8219`. Preparation metadata is left for the runner.

- **Old premise/scope:** the earlier preparation proposed the four-file lint/scaffold change using a Done-when skeleton, described the status filter as open/active only, cited the provenance union at an obsolete line, and proposed a live warning probe against resolved #4958. Its earlier claim that only one repository location contained the values was unsupported and is withdrawn.
- **Corrected premise/scope:** the feature remains absent: the two scoped production modules have the #4409 guard/hint but no proposed provenance helper or hint. Keep the same four-file scope. `we:scripts/backlog/scaffold.mjs:162-172` now inserts hints into the shared Acceptance skeleton before Non-goals; `we:scripts/check-standards-rules.mjs:1492-1500` uses `item.status !== 'resolved'`, not a positive open/active allowlist. `we:scripts/lib/required-status-checks.mjs:325` declares six source values; this card's four-value rule remains its explicit MVP, with the other two deferred as before.
- **Source evidence:** the scanner precedent is `we:scripts/check-standards-rules.mjs:1182-1204`, including its additional edge-case-heading stop. Existing regression fixtures are at `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs:851-892`; scaffold hint placement is asserted at `we:scripts/backlog/__tests__/scaffold.test.mjs:93-96`. #4958 is a resolved incident reference, not a deterministic tightening fixture or implementation touch. Removed its stale line citation and replace the proof with synthetic bodies through the real renderer/linter.
- **Callers/defaults:** `we:scripts/backlog.mjs:750` and `we:scripts/operations/scaffold.mjs:146` consume `renderItem`; the default generated text changes centrally, with no caller signature change. `we:scripts/check-standards.mjs:985` consumes `lintBacklogItemRendering`. Existing cards are not rewritten; bodies lacking the new hint retain normal detection. Current renderer consumers also include `we:scripts/backlog/__tests__/edge-case-classes.test.mjs:42` and `we:scripts/backlog/__tests__/frontmatter.test.mjs:270`; these are regression checks, not anticipated edits.
- **Sizing:** retain size 3. Expected changed lines: approximately 60 in `we:scripts/check-standards-rules.mjs` (scanner and warning beside the cited precedent), 8 in `we:scripts/backlog/scaffold.mjs` (constant and insertion), 100 in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` (matrix and renderer integration), and 15 in `we:scripts/backlog/__tests__/scaffold.test.mjs` (wording/placement). Approximately 183 lines across four files; no task-only estimatedLoc field.
- **Verification limits:** read-only source inspection established the current behavior and absent exports. No new tests or implementation have been written in this preparation. A zero-test selection is not a RED proof; the builder must add the cases before measuring RED.

## Design

Extend the existing warning-only authoring heuristic, retaining the previously prepared policy and four-value set.

1. In `we:scripts/check-standards-rules.mjs`, export proposed `findProvenanceVerdictGaps(body)`. Normalize null/undefined to empty text as the neighboring helper does. Scan top prose before Design, Test plan, Progress, or the existing edge-case heading; skip fenced code and both exact scaffold hint lines. Use the sibling sentence splitting approach. Trigger only when one sentence has a tightening token (`tighten` with suffixes, `stricter`, or `harden` with suffixes) and an external-set token (`externally sourced`, `cache`/`cached`, `fetched`, `provenance`, or `required checks`/`required-check`). Explicitly cover the original example, “Tighten the verdict on the cached required-check set.”
2. Once triggered, return one `{ kind: 'missing-provenance-case', detail: value }` for each absent value in the fixed order `live`, `cache`, `stale-cache`, `fallback`. Match case-insensitively with `(?<![\w-])value(?![\w-])`; embedded words or hyphenated compounds do not count as that value. Presence is a prose heuristic, not verification that runnable tests exist. The author must put the test-per-value Must in the top digest or Acceptance before the first stopping heading. Merely mentioning values elsewhere cannot satisfy the scan.
3. Wire the helper beside #4409 in `we:scripts/check-standards-rules.mjs:1492` under the same non-resolved status predicate. Add one warning listing all missing values and instructing the author to add a Must requiring one test per provenance value. Do not add errors, change existing warning text, or create kind/scope exemptions.
4. Export proposed `PROVENANCE_VERDICT_HINT` from `we:scripts/backlog/scaffold.mjs`: “Hint: a card that tightens a verdict on an externally sourced set needs a Must line requiring one test per provenance value: live, cache, stale-cache, fallback.” Insert it after `GUARD_RELAXATION_HINT` in Acceptance, before Non-goals. Import and strip the exact constant in the new scanner, so default template text never supplies evidence. Keep the shared task-agreement renderer unchanged.
5. **Closed evidence path and limits:** a triggered card with absent, partial, fenced-only, or hint-only coverage retains every missing-value warning. This is advisory authoring feedback, not a new admission refusal. Empty or null text does not establish a trigger and returns no gaps; it is not a certification of completeness. Existing parse/structural checks remain responsible for invalid cards. Broad cache-related prose can warn even about TTL changes, as already accepted by the prior preparation; no runtime provenance semantics are changed.

## MVP

**Must**

1. Add the pure four-value scanner and exact-token, sentence, and region behavior specified above.
2. Integrate one warning for non-resolved cards, preserving existing errors and applying regardless of input scope or card kind.
3. Emit and strip the exact new hint; cover real renderer output and historical bodies so the changed default cannot silently satisfy the new rule.

**Could:** derive source values from a shared exported vocabulary; add a review lens that checks source handling; verify named executable cases instead of prose tokens. These remain follow-ups, not implementation dependencies.

## Test plan

All new case names include `4810`. A1–A4 map every Must to a named executable test; new-helper cases are capability cases (fail before implementation due to missing export). Do not call them preservation tests that pass while that helper is absent.

- **Capability, A1:** table-driven no-values, complete-values, and four omit-one cases. Each omitted value must independently retain its exact warning detail; the stale-cache-only case must still report cache.
- **Capability, A2:** exercise every tightening and external-set spelling; non-tightening external prose and tightening-only prose stay silent. Split keywords across sentences stay silent. Check exact-token counterexamples, fences containing triggers versus fences containing values, each stopping heading, empty/null text, and non-scanned values. Removing the sentence conjunction, fence exclusion, or stop boundary must break the respective assertion.
- **Capability, A3:** run the public linter with open, active, parked, resolved, and missing-status fixtures; assert only the new warning's count/text and unchanged error arrays compared with the equivalent non-triggering body. Cross story/task kinds with source/docs/config/data scope. Complete coverage emits no new warning. This exercises fail-closed evidence retention without inventing a hard-failure policy.
- **Capability, A4:** pin wording and placement in the scoped scaffold test. In the content-lint test, call the actual renderer with triggering and unrelated digests, then add an authored Must listing all four before the first scan boundary. Hint-only evidence must fail to clear gaps; an older body without the hint must still work.
- **Preservation:** existing #4409 tests and existing scaffold agreement/edge-case/frontmatter tests pass on both base and implementation. Mutation proof: remove the old hint or move hints outside Acceptance to make their existing placement assertions fail; remove the old scanner's hint exclusion to make its fresh-scaffold tests fail. No historical fixture is weakened to accommodate the new hint.

## Proof plan

Use the host heavy queue for every test or standards run. The following runnable recipe keeps repository-qualified paths explicit; shell prefix removal resolves them relative to the WE checkout. Run the targeted command first after adding the tests but before production edits (require a failing named case or missing export, not zero selected tests), then repeat after implementation (require all A1–A4 cases to pass).

```sh
QUEUE=we:scripts/readiness/heavy-admission.mjs
LINT_TEST=we:scripts/__tests__/check-standards-rules-content-lint.test.mjs
SCAFFOLD_TEST=we:scripts/backlog/__tests__/scaffold.test.mjs
node "${QUEUE#we:}" run --wait-ms=60000 -- npx vitest run "${LINT_TEST#we:}" "${SCAFFOLD_TEST#we:}" -t 4810
```

After GREEN, run the complete affected files and existing adjacent renderer regression tests once, through the same queue:

```sh
EDGE_TEST=we:scripts/backlog/__tests__/edge-case-classes.test.mjs
FM_TEST=we:scripts/backlog/__tests__/frontmatter.test.mjs
node "${QUEUE#we:}" run --wait-ms=60000 -- npx vitest run "${LINT_TEST#we:}" "${SCAFFOLD_TEST#we:}" "${EDGE_TEST#we:}" "${FM_TEST#we:}"
node "${QUEUE#we:}" run --wait-ms=60000 -- npm run check:standards
```

If the queue remains busy after its single bounded wait, stop and report; do not poll. Record RED/GREEN case counts and actual standards exit status in Progress. The actual renderer-to-public-linter fixture in A4 is the deterministic surface probe. Inspect the standards output for new warning count and representative findings to make heuristic noise reviewable; resolved #4958 is not used as positive evidence. Existing unrelated failures must be reported separately, never described as a passing gate.

## Follow-ups

- Consider a shared exported source vocabulary in `we:scripts/lib/required-status-checks.mjs:325`, including `declared` and `unavailable`; changing this MVP's four-value policy belongs to that follow-up.
- Add the separately suggested review-lens check for `source:` handling, with a concrete lens owner and tests when scoped.
- Verify a named test per value rather than token presence, and consider a section-aware scan that supports later Acceptance sections. The current top-region limitation is explicit and covered, not silently broadened here.

## Non-goals

- [N1] No runtime required-check resolution changes, retrospective card rewriting, resolved-card warnings, hard admission gate, or change to the existing guard-relaxation rule.
