---
bornAs: xc1zo4f
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4709-prevention-add-a-check-standards-or-prepare-stamp-gate-any-c.md", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-21"
preparedAgainstSha: "bc62721fb5a2f807f0a9c53c60c5ecf7cd3eb188"
tags: []
---

# Prevention — When the builder implements the detector, add a test that runs findDoneWhenGaps over this card's own bo… (from chalbert/web-everything#3644 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. Review guard from the Done-when acceptance example in `we:backlog/4709-prevention-add-a-check-standards-or-prepare-stamp-gate-any-c.md`: run the detector over that reviewed card's own body and expect `[]`; anchor placeholder detection to the scaffold line shape rather than a bare substring.
2. Review guard from that card's MVP and Test plan: a stamped decision or epic without Done-when must produce no Done-when warning; state one consistent detector signature.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3644@09aef17ff25924ac7adc66969c1f8e3baf4eb444

## Progress

- Rechecked 2026-11-21 at `bc62721fb5a2f807f0a9c53c60c5ecf7cd3eb188`. The old preparation assumed a numbered Done-when-only scaffold and no placeholder guard. Corrected premise: `we:scripts/backlog/task-agreement.mjs:25` recognizes Acceptance and legacy Done when; its skeleton at line 58 emits `[A1]` acceptance. `we:scripts/backlog/scaffold.mjs:12` imports that producer. The old scaffold line 113 citation is obsolete.
- Partial delivery is not completion: `we:scripts/check-standards-rules.mjs:1352` already detects unfinished acceptance beside proof claims, and lines 1447–1457 also enforce executable-acceptance policy on prepared open cards. These are existing error paths to preserve, not the proposed stamped story/task gap warning. Targeted searches of that module and `we:scripts/backlog.mjs` found no `findDoneWhenGaps`. The full goal remains outstanding.
- The current compatibility tests are in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs:896–940`; they pin both headings and the real scaffold producer. `findMustWithoutDoneWhen` at `we:scripts/check-standards-rules.mjs:1304` checks Must citations, not general acceptance completeness. Reuse the shared agreement reader rather than restoring a Done-when-only parser.
- Scope remains the reviewed specification, detector/lint module, and matching content-lint suite. The shared reader and scaffold are read-only dependencies. Keep size 3: approximately 35 changed specification lines, 45 detector/caller lines, and 100 regression-test lines across the three scoped files. No runtime, stamp, or conveyor edits belong to this guard.
- The reviewed specification still contradicts itself: Design takes a body, MVP Must 3 reads metadata from an item, and the placeholder rule uses a substring. Correct these during the build, including its obsolete section/scaffold descriptions. This preparation edits only this card. #4709 remains open and owns implementing the detector and stamp gate; the dependency is proposed below, not silently added to frontmatter. Existing preparation stamps are left for the runner.

## Design

Retain the proposed pure signature `findDoneWhenGaps(body)`. In `we:scripts/check-standards-rules.mjs`, consume `readTaskAgreement` from `we:scripts/backlog/task-agreement.mjs` for canonical Acceptance and legacy Done when, preserving its canonical precedence and exclusion of fenced/commented examples. Return an empty array only for an actual acceptance section containing a numbered acceptance clause and no scaffold placeholder. Preserve #4709's gap kinds: `missing-section`, `no-numbered-clause`, and `placeholder-clause`; canonical `[A<n>]` clauses count alongside legacy numbered clauses. Missing, empty, or non-string body evidence must produce a gap, never success. Non-goals completeness is outside this detector.

Recognize the scaffold prefix at the beginning of an acceptance clause's text: bold Executable label, em dash, then `TODO:`. Match both current `[A1]` and legacy numbered forms through the shared reader, with horizontal-spacing and CRLF coverage. A later mention of `TODO:` in a substantive clause is not a placeholder. Design/Test plan prose, fenced examples, and comments cannot satisfy missing acceptance or trigger a placeholder finding.

Metadata stays with `lintBacklogItemRendering`: emit the new warning only for story/task records with a non-empty `preparedAgainstSha` and status other than resolved. Decisions and epics bypass this warning. Preserve existing executable-acceptance errors and their policy/default behavior; exemption from this warning does not exempt a card from other checks. Do not change the prerequisite's first-stamp/re-stamp behavior.

Align the reviewed specification in `we:backlog/4709-prevention-add-a-check-standards-or-prepare-stamp-gate-any-c.md` with this signature, shared format, and caller filtering. Read that actual card from disk in the content-lint suite, strip frontmatter, and expect `[]`; do not sanitize placeholder-token mentions or substitute a synthetic body. A failed fixture read must fail the test rather than skip it.

## MVP

**Must**
1. Align the reviewed specification's Design, MVP, Test plan and acceptance descriptions with the body-only interface, canonical/legacy formats, anchored placeholder rule and caller-owned metadata.
2. Harden the prerequisite detector and lint caller in `we:scripts/check-standards-rules.mjs` to implement the contract above, reusing the shared reader and preserving existing error gates.
3. Add named regressions in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` for the actual reviewed body, real generated scaffold, format compatibility, fail-closed missing evidence and caller eligibility.

## Test plan

All named tests below are planned additions to `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`. Capability tests are expected RED because the detector export is absent; that is an inspected prerequisite, not a claimed test run.

- `4783 reviewed card body is accepted`: read the actual reviewed card, strip only frontmatter, assert `[]`. Pair with `4783 later TODO mention is substantive` for both headings. A bare-substring matcher must fail the latter and the actual reviewed-body case.
- `4783 generated and legacy scaffold are rejected`: use the real `renderItem` producer plus a legacy numbered fixture; assert `placeholder-clause`, including CRLF and horizontal-spacing variants. Returning `[]` unconditionally must fail these controls.
- `4783 missing evidence fails closed`: absent, null and non-string input, missing section, and a heading found only inside a fence/comment yield `missing-section`; empty and prose-only sections yield `no-numbered-clause`. Pair with valid canonical and legacy clauses. A detector that accepts empty input or counts quoted headings must fail this test.
- `4783 canonical acceptance wins`: when both headings exist, apply shared-reader canonical precedence; ignore examples and placeholder prose outside acceptance. A legacy-first or whole-body scan must fail.
- `4783 stamped kind matrix`: stamped unresolved stories/tasks without acceptance warn; stamped decisions/epics do not; unprepared and resolved stories/tasks do not. Assert only the new warning, not absence of all diagnostics. Positive cases are capability; negative cases preserve existing behavior. Removing each kind/stamp/status guard must fail its row.
- `4783 existing placeholder errors survive`: retain the current policy-controlled prepared-card error and proof-claim error tests, including canonical and legacy headings. This is preservation; disabling either existing error path must fail its assertion. No policy default changes are intended.

## Proof plan

After #4709 lands, record its commit and run the named suite through the host queue: use `node` on `we:scripts/readiness/heavy-admission.mjs` with `run --wait-ms=60000 -- npx vitest run` followed by `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` (strip repository prefixes from argv paths when executing from WE). Capture the baseline failures of the new capability tests, then the passing implementation. If the prerequisite already passes a case, record it as preservation and use the specified mutation to demonstrate sensitivity instead of asserting a fictitious baseline failure.

Run the focused suite against each temporary mutation in Test plan, restore the implementation, and require a final green run. Missing fixture reads must remain hard test failures. Review the actual reviewed-card fixture alongside the specification changes to ensure its text matches the implemented signature and kind filter. Existing compatibility and placeholder-error tests must stay green.

The runner owns preparation checks and stamping. At build time run `npm run check:standards` through the same heavy-admission queue; warning-level success alone is not evidence for exemptions. If capacity is unavailable, wait once with the queue's own bounded wait, then report the missing verification. No implementation tests are claimed as passed by this preparation.

## Follow-ups

#4709 owns stamp refusal, idempotence and conveyor handling, including their tests. Citation-staleness and external-text sanitization remain its separate follow-ups. Additional placeholder vocabularies and changes to agreement policy/defaults are outside this guard; no new policy decision is needed to preserve the shipped canonical/legacy formats.

## Proposed blockedBy changes

- add 4709 — supplies the detector this guard hardens; its open specification defines the implementation and stamp work (we:backlog/4709-prevention-add-a-check-standards-or-prepare-stamp-gate-any-c.md:35). No reverse dependency appears in that card's frontmatter; independent reviewer confirmation is required.

## Acceptance

- [A1] **Executable** — The focused queued Vitest run of `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, test `4783 reviewed card body is accepted` and its later-token companion, fails without the proposed export or under a bare-substring matcher and passes after; the real reviewed specification consistently describes the tested contract (Musts 1–3).
- [A2] **Executable** — The same run's `4783 generated and legacy scaffold are rejected` and `4783 canonical acceptance wins` tests fail with absent detection or legacy-only parsing and pass after, covering the current producer and persisted legacy format (Musts 2, 3).
- [A3] **Executable** — The same run's `4783 missing evidence fails closed` test fails before the detector exists and under an accept-empty mutation, then passes after; absent or quoted-only evidence never counts as valid acceptance (Musts 2, 3).
- [A4] **Executable** — The same run's `4783 stamped kind matrix` fails before warning integration and passes after; removing each caller guard fails the corresponding exclusion rows (Musts 2, 3).
- [A5] **Executable** — The same run's `4783 existing placeholder errors survive` fails when either existing error path is disabled and passes with the final implementation; existing policy/default behavior and both heading forms remain covered (Musts 2, 3).

## Non-goals

- [N1] Implementing or changing stamp/conveyor behavior, agreement policy, Non-goals validation, or unrelated placeholder error semantics.
