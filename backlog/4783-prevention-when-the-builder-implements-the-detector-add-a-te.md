---
bornAs: xc1zo4f
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4709-prevention-add-a-check-standards-or-prepare-stamp-gate-any-c.md", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-21"
preparedAgainstSha: "a70ef56b5d94e34a4a4c82ce66df653bec323238"
tags: []
---

# Prevention — When the builder implements the detector, add a test that runs findDoneWhenGaps over this card's own bo… (from chalbert/web-everything#3644 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. Review guard from the Done-when acceptance example in `we:backlog/4709-prevention-add-a-check-standards-or-prepare-stamp-gate-any-c.md`: run the detector over that reviewed card's own body and expect `[]`; anchor placeholder detection to the scaffold line shape rather than a bare substring.
2. Review guard from that card's MVP and Test plan: a stamped decision or epic without Done-when must produce no Done-when warning; state one consistent detector signature.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3644@09aef17ff25924ac7adc66969c1f8e3baf4eb444

## Progress

- Rechecked on 2026-11-21 at HEAD `a70ef56b5d94e34a4a4c82ce66df653bec323238`. The old preparation assumed a numbered Done-when scaffold emitted directly by `we:scripts/backlog/scaffold.mjs:113` and no placeholder check. Corrected premise: `we:scripts/backlog/scaffold.mjs:168` delegates to `renderTaskAgreementSkeleton` in `we:scripts/backlog/task-agreement.mjs:57`, emitting Acceptance with `[A1]`. The shared reader supports legacy Done when too (`we:scripts/backlog/task-agreement.mjs:109`).
- Searching `we:scripts/` finds no `findDoneWhenGaps` implementation. Existing checks are narrower: Must citations at `we:scripts/check-standards-rules.mjs:1306`, a placeholder-plus-proof detector at `we:scripts/check-standards-rules.mjs:1353`, and preparedDate/policy-gated placeholder errors at `we:scripts/check-standards-rules.mjs:1447`. These do not deliver the proposed gap-array contract or missing-section warning. This is not already done.
- Old scope and corrected scope both comprise the reviewed #4709 specification, the lint implementation, and its content-lint tests. Correction is behavioral: support the current canonical agreement as well as the legacy format, reuse the shared reader, and leave the separately shipped proof/policy checks intact. The fixture is the reviewed #4709 body, not this follow-up body. Existing parity/scaffold tests are at `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs:896` and `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs:924`.
- Retain size 3: approximately 30 changed lines in the reviewed specification, 45 in the lint implementation and 100 in its matching suite (175 total), grounded in the interfaces and fixture tables above. This is a story, so no estimatedLoc field is added. Existing preparation stamps are left for the runner.
- #4709 remains open and supplies the detector and stamp integration. Its Design conflicts with its MVP on the detector signature and uses the obsolete scaffold shape (`we:backlog/4709-prevention-add-a-check-standards-or-prepare-stamp-gate-any-c.md:41`, `we:backlog/4709-prevention-add-a-check-standards-or-prepare-stamp-gate-any-c.md:70`). This item aligns that specification and supplies the review guards; it does not independently implement stamp or conveyor policy.

## Design

Keep the proposed pure interface `findDoneWhenGaps(body)` in `we:scripts/check-standards-rules.mjs`. Return the prerequisite's gap array: missing acceptance section → `missing-section`, no real acceptance clauses → `no-numbered-clause`, a scaffold-shaped unfinished executable clause → `placeholder-clause`, otherwise `[]`. Use `readTaskAgreement` from `we:scripts/backlog/task-agreement.mjs` for canonical Acceptance and legacy Done when section/clause interpretation, including fence/comment exclusion and section precedence. Do not make Non-goals or MVP requirements part of this detector.

Match the beginning of the normalized clause text: bold Executable label, horizontal whitespace, em dash, horizontal whitespace, then `TODO:`. Both canonical `[A<n>]` and legacy numbered clauses must work; tolerate CRLF and horizontal spacing. A later mention of the token in genuine acceptance text is not a placeholder. Read the actual scaffold producer in tests, alongside a legacy fixture. Missing/null/empty body must yield a missing-section gap, and prose or fenced examples alone must not satisfy the clause requirement. Gap precedence is missing section, then no clauses, then placeholder.

The caller owns metadata: `lintBacklogItemRendering` emits the new gap warning only for story/task records with non-empty `preparedAgainstSha` and status other than resolved. Decisions, epics and unstamped records bypass this warning. Assert this warning specifically; other warnings/errors remain independent. Preserve the existing preparedDate/policy check and mutation-proof check in `we:scripts/check-standards-rules.mjs:1447`; their defaults and eligibility are not being changed.

Align the Design, MVP, Test plan and acceptance wording in `we:backlog/4709-prevention-add-a-check-standards-or-prepare-stamp-gate-any-c.md` with this signature, canonical/legacy formats and caller filtering. Keep its first-stamp/re-stamp policy intact. Its real body, frontmatter stripped and otherwise unsanitized, must yield `[]`.

## MVP

**Must**
1. Align the reviewed #4709 specification with the body-only detector and current agreement format.
2. Harden the prerequisite detector and lint caller in `we:scripts/check-standards-rules.mjs` with the matching and eligibility contract above.
3. Add named regression tests in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` for the actual reviewed body, real scaffold, legacy parity, missing evidence and caller matrix. Preserve existing placeholder-policy and proof-claim tests.

## Test plan

All new cases live in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`:

- `reviewed 4709 body is valid`: load the actual scoped card, strip only frontmatter, expect `[]`. Keep its real acceptance discussion of `TODO:`. A bare substring matcher must fail this test.
- `canonical and legacy scaffold clauses are gaps`: use the real skeleton producer and a legacy numbered fixture, plus CRLF/horizontal-space variants; expect `placeholder-clause`. `later TODO mentions are valid` checks real clauses under both headings and token mentions outside the section.
- `missing evidence cannot satisfy acceptance`: null, empty and absent sections produce `missing-section`; prose-only and fenced/commented clauses produce `no-numbered-clause`. Valid clauses without MVP or Non-goals still pass. An always-empty detector must fail these controls.
- `stamped kind matrix`: story/task with missing acceptance warn; decision/epic with that same body do not. Repeat story/task for empty/missing stamp and resolved status and assert no new gap warning. Removing each caller guard must fail its corresponding negative row.
- `reviewed specification agrees with detector`: assert the corrected signature and canonical/legacy and caller-filter statements in the real #4709 body; reject the old instruction that the detector reads metadata from item. This test fails on the current inconsistent specification.

These are planned tests, not executed proof. Detector-dependent tests fail today because its export is absent; exemption rows are preservation controls and must additionally be demonstrated red under the specified guard mutations after #4709 lands.

## Proof plan

Record the #4709 implementation commit before building this follow-up. Run the focused suite via the host heavy-run queue, using `node` with `we:scripts/readiness/heavy-admission.mjs` and arguments `run --wait-ms=60000 -- npx vitest run` followed by the repo-relative form of `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`. Capture the new tests failing on the prerequisite baseline, then passing after the hardening. If a prerequisite already satisfies one guard, record its baseline pass and demonstrate the named mutation failure rather than claiming a false initial failure.

Individually mutate the matcher to bare substring detection, disable gap detection, and remove kind/stamp/status filters; require the corresponding named tests to fail. Restore the implementation and require the focused suite green, including the existing canonical/legacy and proof-policy cases. Through the same queue run `npm run check:standards`; warnings alone cannot establish the behavior, so retain the focused assertion output. The runner owns preparation checks and stamping; this preparation does not claim future implementation tests passed.

## Follow-ups

#4709 retains ownership of stamp refusal, idempotence and conveyor propagation, plus its separate citation-staleness and external-text work. No default policy change, new configuration, external input channel, or broader Markdown grammar is needed here. The shared agreement reader and scaffold are read-only dependencies for this touch set.

## Acceptance

- [A1] **Executable** — Focused content-lint test `reviewed 4709 body is valid` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` fails before detector delivery and passes after; a bare-token mutation fails it (Musts 2, 3).
- [A2] **Executable** — Tests `canonical and legacy scaffold clauses are gaps` and `later TODO mentions are valid` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` fail before delivery and pass after, covering the changed scaffold format and legacy callers (Musts 2, 3).
- [A3] **Executable** — Test `missing evidence cannot satisfy acceptance` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` fails before delivery and passes after; disabling detection fails its missing/prose/fenced controls (Musts 2, 3).
- [A4] **Executable** — Test `stamped kind matrix` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` fails before warning integration and passes after; kind/stamp/status mutations fail the exemption rows. Existing proof/policy tests remain green, preserving their defaults (Musts 2, 3).
- [A5] **Executable** — Test `reviewed specification agrees with detector` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` fails on the current #4709 specification and passes after alignment (Must 1).

## Non-goals

- [N1] Implementing #4709's stamp/conveyor gate or changing its first-stamp/re-stamp policy.
- [N2] Changing existing proof-claim or preparedDate/policy-based errors, or broadening agreement-reader grammar.
