---
bornAs: xfc0tcf
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/backlog/scaffold.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs", "we:scripts/backlog/__tests__/scaffold.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "2b361c583a09326864a819321d456c4aa19bdc4f"
tags: []
---

# Prevention — Add a card-template Must line for any change that tightens a verdict on an externally sourced set. It s… (from chalbert/web-everything#3424 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4958-a-cancelled-required-check-still-strands-a-pr-in-awaiting-ci.md` — Add a card-template Must line for any change that tightens a verdict on an externally sourced set. It should require one test per provenance value (`live`/`cache`/`stale-cache`/`fallback`). A lens check that greps for `source:` handling would also catch it.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3424@641b380b6bbe21000b084ea18581cf9f60ca3b17

## Progress

Re-preparation against checkout `2b361c583a09326864a819321d456c4aa19bdc4f`. Runner owns stamping; existing preparation metadata is untouched.

- **Old premise:** the scaffold owned a `## Done when` skeleton, the sibling guard applied only to open/active cards, and the required-check source union lived at line 122. **Corrected premise:** `we:scripts/backlog/scaffold.mjs:169` inserts its hint into the shared Acceptance skeleton from `we:scripts/backlog/task-agreement.mjs:57`; `we:scripts/check-standards-rules.mjs:1492` actually excludes only resolved cards. The union is now at `we:scripts/lib/required-status-checks.mjs:325` and still includes the four requested values plus declared/unavailable. The old line citation on card #4958 was not implementation evidence; retain that card as lineage only.
- **Delivery check:** source search finds neither the proposed provenance helper nor hint in the scoped implementation and test files. The existing sibling helper is at `we:scripts/check-standards-rules.mjs:1182`; its template hint is at `we:scripts/backlog/scaffold.mjs:19`. The requested guard remains missing.
- **Old scope → corrected scope:** the four current scope entries remain the complete touch set; no runtime required-check change or shared agreement-format change is needed. Correct the stale insertion locations rather than expanding scope. Callers already use the shared renderer: `we:scripts/backlog.mjs:750` and `we:scripts/operations/scaffold.mjs:146`. The standards runner calls the shared rendering lint at `we:scripts/check-standards.mjs:985`.
- **Size:** retain 3. Expected changes: about 55 lines in `we:scripts/check-standards-rules.mjs`, 8 in `we:scripts/backlog/scaffold.mjs`, 100 in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, and 20 in `we:scripts/backlog/__tests__/scaffold.test.mjs`. Existing sibling coverage begins at `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs:851`; hint-placement assertions are at `we:scripts/backlog/__tests__/scaffold.test.mjs:94`. This is a story; no estimatedLoc field is added.
- Previous claims that missing-function tests were already green, or that the real #4958 body necessarily triggers this heuristic, were not valid proof. New tests and before/after execution belong to implementation, not this card-only preparation.

## Design

Add the authoring hint and warning-only heuristic beside the existing guard-relaxation implementation. Preserve the previously selected four-value MVP and top-region limitation.

1. Export `PROVENANCE_VERDICT_HINT` from `we:scripts/backlog/scaffold.mjs`: “Hint: a change that tightens a verdict on an externally sourced set needs a Must line requiring one test per provenance value: live, cache, stale-cache, fallback.” Insert it immediately after the existing guard hint and before Non-goals in the rendered Acceptance section. Both current renderer callers inherit this default; leave the shared agreement renderer unchanged.
2. Export `findProvenanceVerdictGaps(body)` from `we:scripts/check-standards-rules.mjs`. Scan string prose before the first Design, Test plan, Progress or canonical Edge cases heading, skipping fenced code and both exact scaffold hints. Reuse the sibling sentence splitting. Trigger only when one sentence contains a tightening token (`tighten*`, `stricter`, `harden*`) and an external-set token (`externally sourced`, `cache`/`cached`, `fetched`, `provenance`, `required checks`/`required-check`). Case-insensitive matching is required. Broad cache-related warnings remain advisory, as in the original preparation.
3. For a triggered region, return one `{ kind: 'missing-provenance-case', detail: value }` for each absent value, in live/cache/stale-cache/fallback order. Match each value with `(?<![\w-])value(?![\w-])`; stale-cache alone cannot satisfy cache. This is a mention heuristic, not proof that tests exist or a Must is semantically sufficient. The hint instructs the author to write the actual Must line; bare hint text cannot satisfy it.
4. Wire one aggregated warning into `lintBacklogItemRendering` beside the existing guard. Match the actual sibling predicate: every status except resolved, without kind or source/docs/config/data exemptions. Include missing values and the instruction to add the Must/test matrix. Do not add errors or alter existing diagnostics.
5. Empty/nullish bodies have no trigger and return no gaps. This helper parses prose, not frontmatter; remove the old promise about “unparseable body.” Existing frontmatter validation remains authoritative. The closed path for a triggered card with absent or fenced-only coverage is an explicit warning, never a claim of complete coverage. This advisory check does not grant readiness or replace any refusal gate.

## MVP

**Must**

1. Add the four-value helper with sentence, token, region and hint exclusions specified above.
2. Wire the warning into the real rendering lint for all non-resolved statuses and all card kinds; preserve warning-only severity and existing validation.
3. Emit the exact new hint by default through the shared scaffold renderer, preserving existing hint placement and agreement headings.

## Acceptance

- [A1] **Executable** — Must 1: proposed test `4810 missing and partial provenance matrix` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` fails before the helper exists and passes after; assert all four missing, each single-value omission, full coverage, and stale-cache not satisfying cache.
- [A2] **Executable** — Must 1: proposed test `4810 trigger and scan boundaries` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` fails before and passes after; assert trigger variants, separate-sentence negatives, non-tightening prose, empty/nullish input, both hints, fenced triggers/values, and every stopping heading.
- [A3] **Executable** — Musts 1-2: proposed test `4810 warning integration and closed coverage path` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` fails before the warning exists and passes after; missing coverage and fenced-only values warn, full coverage does not, errors remain unchanged, and warnings enumerate exactly the missing values.
- [A4] **Executable** — Must 2: proposed test `4810 status kind and input-category parity` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` fails before and passes after; exercise open, active, parked and absent status against resolved, story/task/decision kinds, and source/docs/config/data descriptions. Only resolved suppresses this warning.
- [A5] **Executable** — Must 3: proposed test `4810 default scaffold hint and lint roundtrip` in `we:scripts/backlog/__tests__/scaffold.test.mjs` fails before and passes after; pin the exact hint and placement, then pass rendered tightening and unrelated digests through the real lint. The default hint neither satisfies missing coverage nor triggers a warning by itself. Both renderer callers inherit the tested output without caller-specific switches.

## Test plan

- **Capability (fails before):** implement A1-A4 in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, using an exported-helper assertion for unit cases and the real `lintBacklogItemRendering` for integration. Use table cases for each provenance value and each status/category; do not infer cache independence from a fixture that already names cache.
- **Capability (fails before):** implement A5 in `we:scripts/backlog/__tests__/scaffold.test.mjs`. Build fixtures with `renderItem`, not copied skeleton text. Include a tightening digest with no values and a non-tightening digest; assert the provenance warning specifically, independent of unrelated scaffold warnings.
- **Preservation (passes on both):** retain existing #4409 tests and scaffold heading/size/scope assertions in both scoped suites. Mutation proof: remove the old hint insertion or change the old helper's status predicate and the corresponding existing assertions must fail. New helper negative cases are capability tests because the helper is absent on the base; do not label them baseline-green.

## Proof plan

1. During implementation, add the named tests first and run only the two scoped suites through the host heavy-run queue. Record actual red assertions or missing-export failures on the unchanged implementation; an empty test selection is not red proof.
2. Implement the four-file touch set and run those same suites through the queue. Record green counts and use the A5 renderer-to-lint roundtrip as the running producer/consumer probe. Run the complete two affected files so existing assertions also execute.
3. Queue `npm run check:standards` and record its exit status and provenance-warning count. The new rule must add no errors; report unrelated failures distinctly. Inspect representative new warnings to expose the intentionally broad heuristic. Do not assume card #4958 is a positive fixture without observing its current prose.
4. Queue entry point: `we:scripts/readiness/heavy-admission.mjs`, invoking the scoped Vitest command with the two test paths in scope (strip the documentation-only we: prefix for shell arguments). If occupied, use one admission wait only, then report the result. The runner owns preparation checks and stamping; no tests of future code are claimed by this preparation.

## Follow-ups

- Consider deriving values from an exported source vocabulary in `we:scripts/lib/required-status-checks.mjs`, including declared/unavailable. This MVP intentionally implements the four requested values only.
- Add the separately suggested review-lens check for source handling.
- Validate that the Must line names real per-value tests, rather than merely mentioning the four values.
- Revisit the top-region limit jointly with the sibling guard; coverage written only after Design/Progress currently cannot satisfy either heuristic.

## Non-goals

- [N1] No runtime required-check verdict changes, policy settings, hard admission gate, or retroactive warnings on resolved cards.
- [N2] No rewriting either renderer caller, the shared task-agreement schema, or existing cards; no automatic inference that a warning-free body proves test coverage.
