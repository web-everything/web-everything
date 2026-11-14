---
bornAs: xm9goqs
kind: task
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/review-extra-seats.test.mjs", "we:scripts/lib/jury-core.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs", "we:scripts/lib/review-core.mjs", "we:scripts/lib/__tests__/review-core.test.mjs", "we:scripts/lib/review-policy.mjs", "we:scripts/__tests__/review-core-cli.test.mjs", "we:scripts/lib/__tests__/review-policy.conformance.test.mjs", "we:scripts/lib/review-policy.contract.json", "we:scripts/operations/__tests__/review-pr.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-13"
preparedAgainstSha: "3a988c24eab0a4870d30087668fb32d93f81971d"
tags: []
---

# Add a deterministic spec-consistency review lens (or truth-check red-team step) to the jury panel

Follow-up from we:backlog/4314-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md, guard 3 (prevention owed by chalbert/web-everything#2831's independent review, referencing we:backlog/4308-drain-lands-a-ready-pr-after-not-before-a-larger-overlapping.md): "A deterministic review lens (Verify that spec constraints are mathematically consistent) or a truth-check red-team step (like the Jury refinement method) would catch it."

## Background
we:backlog/4308-drain-lands-a-ready-pr-after-not-before-a-larger-overlapping.md's own review history (its Independent plan review sections) shows more than one blocking/major finding that was a pure LOGICAL/mathematical inconsistency inside the spec itself — a window counted from the wrong anchor failing to bound total wait, an overlap-relative size order that can cycle, a filtering point that misses a live code path — caught only by an ad hoc Codex prose pass, not by any of the panel's EXISTING deterministic lenses (we:scripts/lib/jury-core.mjs#PANEL_LENSES / MANDATE_LENSES). This finding asks for a repeatable, deterministic lens or red-team step that specifically targets that class of gap: a spec's own stated invariants/rules contradicting each other or failing to hold under a stated edge case, independent of whether the CODE matches the spec.

## Design gist
Add either (a) a new ADVISORY lens (we:scripts/lib/jury-core.mjs#ADVISORY_LENSES) whose prompt/validation asks each juror to restate every numbered rule/invariant the spec section under review declares and check them pairwise for a contradiction or an unhandled edge case (a cycle, an unbounded value, a boundary the rules never resolve) — never a code-correctness question, purely "do these stated rules agree with each other and cover their own stated edge cases" — or (b) a red-team step in the existing convergence loop (we:scripts/lib/converge-core.mjs) that runs after the panel accepts, specifically trying to construct a concrete counterexample input that breaks one of the spec's own stated invariants.

## Edge cases the lens/step must handle
- A spec with no explicit numbered rules/invariants at all (prose only): the lens must degrade to "no structured claim found, nothing to check" rather than fabricating rules to critique.
- A spec whose rules are consistent but INCOMPLETE (a case the rules simply do not address): distinguish "contradiction" (must flag) from "silence" (may flag as a gap, must never be conflated with a hard contradiction in the verdict wording).
- A very large spec section (many rules): bound the pairwise check so it cannot blow up the panel's round budget or juror cost — a documented cap, not an unbounded all-pairs scan for a huge rule count.
- The lens finding something: it must render through the existing renderPanelComment/Prevention-OWED machinery (we:scripts/lib/review-render.mjs) like every other lens finding, not a bespoke output shape.

## Test plan
Unit tests in we:scripts/lib/__tests__/jury-core.test.mjs (or we:scripts/lib/__tests__/review-core.test.mjs, whichever owns the new lens/step) covering the positive case (two stated rules that contradict, e.g. two conflicting orderings that can cycle) and every edge case above. Plus ONE integration/wiring test proving the new lens is actually included in PANEL_LENSES/ADVISORY_LENSES and fans out through the real panel-assembly path (we:scripts/lib/jury-core.mjs), not only unit-tested as an isolated function.

## Why filed, not built here
we:backlog/4314-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md's own MVP built a different, self-contained guard (finding 4, in we:scripts/operations/completion-store.mjs); this finding is a review-process design change spanning the jury/converge machinery and deserves its own dedicated build, filed separately per this repo's single-responsibility/small-file preference. Its own `Done when` is left as the standard un-prepared placeholder on purpose — like every mechanically-filed card, it gets its own PREPARE pass when a delivery agent picks it up.

## Progress

- 2026-11-07 prepare: premise holds on current main (no `spec-consistency` lens exists; the #4487 hits in `git log` are an unrelated PR number and a prevention card). Scope widened from 4 to 6 files: we:scripts/lib/review-policy.mjs (`VALID_CARE_LENSES` literal), we:scripts/__tests__/review-core-cli.test.mjs (pinned lens count) and we:scripts/lib/__tests__/review-policy.conformance.test.mjs are changed by adding a panel lens. Citations in the body re-checked against current line numbers.

- 2026-11-09 re-prepare (prepare-stale): scope file we:scripts/lib/jury-core.mjs changed on main since the 2026-11-07 stamp, but only in the operator-ruling parser region (~:3840-4013, unrelated to the lens enums). Premise re-checked: no `spec-consistency` lens exists, design unchanged. Citations refreshed (line shifts of +1 only; `earnedLenses` pin now at we:scripts/__tests__/review-core-cli.test.mjs:339).

- 2026-11-10 re-prepare (prepare-stale): none of the scope files changed on main since the 2026-11-09 stamp (`git log c9809e20..HEAD` over all scope paths is empty); no `spec-consistency` lens exists; citations re-checked and still hold (`CLAIM_ACCURACY` at we:scripts/lib/jury-core.mjs:1438, `ADVISORY_LENSES` :1735, `PANEL_LENSES` :1775, `LENS_EXPECTATIONS` we:scripts/lib/review-core.mjs:1952, `LENS_HUNT_BRIEF` :1971, `ROUTED_ADVISORY_LENSES` we:scripts/operations/review-dispatch.mjs:195). Design unchanged; stamp refreshed.

- 2026-11-13 re-prepare (prepare-stale): scope files changed on main since the 2026-11-10 stamp only in the red-team/pending-check region of we:scripts/lib/jury-core.mjs and review-pr tests (PRs #6535, #6554); the lens enums are untouched. Premise re-checked: no `spec-consistency` lens exists; design unchanged. Citations refreshed: `buildPanelMandate` now we:scripts/lib/review-core.mjs:1114, `earnedLenses` pin in we:scripts/operations/__tests__/review-pr.test.mjs:2873; the rest re-verified.

## Design

**Choice: option (a), a new ADVISORY lens.** Option (b) (a post-accept red-team step in we:scripts/lib/converge-core.mjs) is out: the convergence loop's red-team hook (`redTeamRequired` / `foldRedTeamVerdict`, we:scripts/lib/jury-core.mjs:1376, we:scripts/lib/jury-core.mjs:1394) is a single post-accept gate keyed to a verdict, not a per-spec check, and a lens reuses fan-out, verdict folding, finding normalisation and rendering for free.

Mechanism, mirroring how `claim-accuracy` (#3035) was added:

1. we:scripts/lib/jury-core.mjs:1415 — add `SPEC_CONSISTENCY: 'spec-consistency'` to `MANDATE_LENSES`, and append it to `ADVISORY_LENSES` (we:scripts/lib/jury-core.mjs:1735) after `CLAIM_ACCURACY`. `PANEL_LENSES` (we:scripts/lib/jury-core.mjs:1775) is derived, so it fans out through the real panel path with no further wiring; `buildPanelMandate` (we:scripts/lib/review-core.mjs:1114) accepts it because it validates against `PANEL_LENSES`. It stays advisory: findings always surface, never block the unanimous-accept path (same structural argument as the claim-accuracy ruling).
2. we:scripts/lib/review-core.mjs:1952 — add a `LENS_EXPECTATIONS` entry (the bar) and a `LENS_HUNT_BRIEF` entry (we:scripts/lib/review-core.mjs:1971; the method, appended by `buildPanelMandate` via `huntBriefForLens`, we:scripts/lib/review-core.mjs:1137). The brief tells the juror to: (i) list every NUMBERED rule/invariant the spec text in the diff declares, quoted verbatim; (ii) check them pairwise for a contradiction, and each against its own stated edge cases (a cycle, an unbounded value, an unresolved boundary, a window counted from the wrong anchor); (iii) never judge code-vs-spec, only spec-vs-spec; (iv) when no numbered rules/invariants exist, answer "no structured claim found, nothing to check" and raise no finding; (v) label a **contradiction** (two rules cannot both hold; may be `broken`) separately from **silence** (a case no rule covers; a gap, `impactIfUnfixed` never above `degraded`) and never use contradiction wording for silence; (vi) cap the check at `SPEC_CONSISTENCY_RULE_CAP = 12` rules (exported const in we:scripts/lib/review-core.mjs): over the cap, check the first 12 in document order, say how many were skipped, and do NOT scan all pairs.
3. The vocabulary mirrors that pin the lens set: `VALID_CARE_LENSES` in we:scripts/lib/review-policy.mjs:50 (a deliberate bare-literal copy, trust-chain leaf) gains `'spec-consistency'`; the conformance suite we:scripts/lib/__tests__/review-policy.conformance.test.mjs already pins it equal to the real enum. The machine-readable contract we:scripts/lib/review-policy.contract.json hard-codes the lens list in its `low`, `elevated` and `high` bands (lines 140, 147, 154) and the conformance suite asserts each band equals `panelRigorForCareLevel` (derived from `PANEL_LENSES`), so all three bands gain `"spec-consistency"` in the same change. The prompt-only rule cap is NOT enforced in code (see Follow-ups). `REVIEW_PANEL_LENSES` in we:scripts/lib/jury-ledger.mjs stays four on purpose (the documented #3035 decision: widening the default ledger roster is a separate call).
3b. **Routed review seats (review-pass finding, verified):** `ROUTED_ADVISORY_LENSES` (we:scripts/operations/review-dispatch.mjs:195) is derived as every `ADVISORY_LENSES` member except `simplicity`, and its own doc says a lens added to `ADVISORY_LENSES` "is routed without an edit here". So the new lens becomes a third routed non-Claude seat (one more provider call per review). The MVP follows that documented derivation (no exclusion ruling is invented here); the build updates the seat-count pins in we:scripts/operations/__tests__/review-extra-seats.test.mjs (the genuine seat counts `toHaveLength(3)` at :142, :149, :542, :569 become 4, and the hard-coded seat-key list near :560-:569 (`advisory-lens:claim-accuracy@agy-claude` …) gains a `spec-consistency` entry; :778 and :933 are reservation/call-id sizes (`want:3`), NOT seat counts, and stay unchanged; a new named test "ROUTED_ADVISORY_LENSES includes spec-consistency" in we:scripts/operations/__tests__/review-extra-seats.test.mjs is red before the build and gives the routed-seat change its own red check; also grep each pinned lens literal, e.g. the four-lens list at we:scripts/operations/__tests__/review-pr.test.mjs:648 and the ledger-roster comment at we:scripts/operations/review-parked-prs.mjs:145, which stay four on purpose) and widens scope to that test file (done in frontmatter). If the operator prefers not to pay for the extra seat, that is the Follow-up "exclude from routing".
4. Rendering: no new output shape. Findings go through `normalizeFinding` (we:scripts/lib/jury-core.mjs:372) like every lens and render via the existing `renderPanelComment`/prevention machinery in we:scripts/lib/review-render.mjs; the brief's contradiction/silence label rides the finding's `summary` text.

## MVP

Musts only:
- The new advisory lens, its expectation + hunt brief (all six brief clauses above), the rule cap constant, and the `VALID_CARE_LENSES` literal.
- Count/vocabulary tests that pin the lens set updated to six (the pinned `5`s and the `ROSTER_CRITIQUE_LENSES` literal).

Out of scope (see Follow-ups): option (b) red-team step, seating the lens in the ledger default roster, blocking-on-impact for this lens, a deterministic (non-LLM) extractor of numbered rules.

## Test plan

In we:scripts/lib/__tests__/jury-core.test.mjs and we:scripts/lib/__tests__/review-core.test.mjs; all fail RED today because `MANDATE_LENSES.SPEC_CONSISTENCY` / the brief do not exist:
- **Wiring (integration):** `ADVISORY_LENSES` contains `spec-consistency`, `MANDATORY_LENSES` does not, `PANEL_LENSES` contains it, and the real jury plan path (`plan.lenses` at we:scripts/lib/__tests__/jury-core.test.mjs:337) seats it with `attachedBy: 'care'`. Fails red: lens absent from the plan.
- **Brief registered:** `huntBriefForLens('spec-consistency')` is non-empty and `buildPanelMandate({lens:'spec-consistency'})` contains it; an unknown lens still throws. Fails red: throws unknown lens.
- **Positive case:** the brief instructs pairwise checking and names a cycle/unbounded/boundary example (assert the example keywords are present). Red: no brief.
- **Edge — prose-only spec:** the brief contains the literal "no structured claim found, nothing to check" instruction and forbids fabricating rules. Red: no brief.
- **Edge — contradiction vs silence:** the brief defines both labels and states silence never takes contradiction wording. Red: no brief.
- **Edge — cap:** `SPEC_CONSISTENCY_RULE_CAP` is exported, equals 12, and the brief interpolates that number and forbids an all-pairs scan over the cap. Red: constant missing.
- **Rendering:** `renderPanelVerdictTable` over `PANEL_LENSES` renders `spec-consistency` as an `advisory` row (no bespoke shape); a `spec-consistency` finding passes through `normalizeFinding` unchanged. Red: the row is absent today (the finding half is a pin, not a red case).
- **Pinned-set updates:** `PANEL_LENSES` `toHaveLength(5)` (we:scripts/lib/__tests__/review-core.test.mjs:580), the `ROSTER_CRITIQUE_LENSES` literal (we:scripts/lib/__tests__/review-core.test.mjs:1684), `earnedLenses` `toHaveLength(5)` plus its "all five lenses" title (we:scripts/__tests__/review-core-cli.test.mjs:339; title at :335), `earnedLenses` `toHaveLength(5)` (we:scripts/operations/__tests__/review-pr.test.mjs:2873), the conformance pin of `VALID_CARE_LENSES`, and the three contract bands in we:scripts/lib/review-policy.contract.json all move to include the lens. Red until updated (the conformance band-vs-rigor assertion fails the moment the lens joins `PANEL_LENSES`).
- **Test naming:** the build names each new test with `spec-consistency` so the `-t` filters in Done when match.

## Edge cases this change must handle

1. **Untrusted text** — n/a: no new text path; the lens only judges diff text through the existing fenced mandate (`buildMandate`), and the new brief is static.
2. **Truncated reads** — n/a: no `gh`/`git` read is added.
3. **Shared state files** — n/a: pure constants; no state file written.
4. **Fail closed** — the lens stays advisory-surfaced: a juror with no verdict counts as no verdict (unchanged `derivePanelVerdict`); an unknown lens in `buildPanelMandate` still throws (tested).
5. **Identity scoping** — n/a: findings keep the existing per-PR identity via `normalizeFinding`; the lens name is just another `category`.
6. **State over time** — n/a: no persisted records; old ledgers seat four lenses and are unaffected (`REVIEW_PANEL_LENSES` unchanged).
7. **Who wrote it** — n/a: no trust is granted by a comment, ref, label or name.

## Proof plan

Before/after on a real surface: print `PANEL_LENSES` from we:scripts/lib/jury-core.mjs (five lenses before, six after) and print `buildPanelMandate({lens:'spec-consistency'})` from we:scripts/lib/review-core.mjs to show the mandate carries the brief and the cap (before: throws `unknown lens`). Also print `ROUTED_ADVISORY_LENSES` from we:scripts/operations/review-dispatch.mjs (two before, three after). Then show the real jury-plan path (fixture in we:scripts/__tests__/converge-cli.test.mjs) lists `spec-consistency` seated as an advisory lens.

## Follow-ups

- Option (b): a red-team step in we:scripts/lib/converge-core.mjs that tries to construct a concrete counterexample input after the panel accepts.
- Decide whether `REVIEW_PANEL_LENSES` (ledger default roster, we:scripts/lib/jury-ledger.mjs) should seat this lens (extra juror cost per review; see the #3035 note there).
- Blocking-on-impact for contradiction findings (parallels `#3339` for claim-accuracy).
- A deterministic extractor that pre-lists numbered rules for the juror, so the cap is enforced in code rather than by prompt.
- Exclude `spec-consistency` from `ROUTED_ADVISORY_LENSES` (provider-cost call) if the extra routed seat per review is not wanted.
- Measure the lens's hit rate on the review replay corpus (we:scripts/review-corpus) before any promotion.

## Done when

1. **[A1] Executable** — `npx vitest run jury-core review-core -t spec-consistency` runs the new wiring, brief, cap and edge-case tests (all named with `spec-consistency`) and passes; before the build it finds none/fails (lens undefined, `huntBriefForLens` returns `''`).
2. **[A2] Executable** — `npx vitest run jury-core -t "spec-consistency is advisory"` passes after the build and fails before (advisory-not-mandatory guarantee: in `ADVISORY_LENSES` and `PANEL_LENSES`, not in `MANDATORY_LENSES`).
3. **[A3] Executable** — `npx vitest run review-core -t "spec-consistency brief"` passes after and fails before (prose-only "nothing to check" degrade, contradiction-vs-silence labels, and the `SPEC_CONSISTENCY_RULE_CAP` guarantees).
4. **[A4] Executable** — `npx vitest run review-core -t "unknown lens"` passes before and after (matches the existing "throws on an unknown lens…" test and the `buildValidatorMandate` one; fail-closed on an unknown lens is unchanged and a regression turns it red).
5. **[A5] Executable** — `npx vitest run review-policy.conformance review-core-cli review-pr review-extra-seats` passes after the build; once the lens is added to `PANEL_LENSES` it fails until `VALID_CARE_LENSES`, the contract JSON bands and the `earnedLenses` counts are updated (the changed lens-vocabulary default and its callers).
6. **[A6] Executable** — `npm run check:standards` is green on the diff.

