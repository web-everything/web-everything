---
bornAs: xaevyiv
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs", "we:scripts/check-standards.contract.json", "we:scripts/lib/__tests__/check-standards.conformance.test.mjs", "we:scripts/__tests__/check-backlog-item.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-20"
preparedAgainstSha: "8635c7b7885f110641582eb15520a7e1ecb1f87d"
tags: []
---

# Prevention — Reject unreconciled operator rulings and unfinished readiness criteria

Add a standards guard that makes an operator ruling's authoritative implementation plan explicit and rejects unfinished Must and executable acceptance criteria before a card is ready for build. Preserve historical evidence without leaving two live instructions for the implementing lane.

Filed mechanically on approval of chalbert/web-everything#3477. The review requested superseded or rewritten Fix lines after an Operator ruling, or one authoritative Plan with older instructions marked as history; it also requested concrete error-path and non-code Must lines for refusal-relaxation work and an executable Done-when criterion.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3477@096956089e23a1440449e9b83ce55fc647c62b78

## Progress

Old premise/scope: the prior preparation said the incident's Design still prescribed immediate normalization, cited lines 42–65, claimed no executable-placeholder guard existed, and prescribed Done when alone. These claims are stale. The five-file shared-lint scope remains appropriate; the incident is evidence, not an implementation target.

Corrected premise/source evidence: `we:backlog/4815-a-not-real-ruling-on-a-tool-less-juror-finding-ends-the-revi.md:41` now explicitly implements the confirmation-turn ruling. An older embedded Fix instruction remains at line 91 beside the ruling at line 93; retain this as a synthetic historical-instruction fixture without adjudicating that card's runtime behavior. `we:scripts/check-standards-rules.mjs:1352` already detects the exact scaffold phrase, and lines 1447–1458 reject it on prepared open cards under the executable-acceptance setting or beside a mutation-proof claim. This is partial delivery, not delivery of ruling reconciliation or general Must completeness. The old empty-errors probe is historical evidence only and was not rerun during this preparation.

Current shared callers are `we:scripts/check-standards.mjs:985` and `we:scripts/check-backlog-item.mjs:100`. Both pass the loaded item to the same lint. `we:src/_data/backlog.js:588` assigns its derived tier; `we:scripts/check-backlog-item.mjs:80` has a fallback record without tier. Explicitly diagnose missing readiness metadata rather than silently treating it as a known non-ready draft. No caller source edit is needed: the shared lint receives that distinction. The scoped CLI tests already isolate cards using a temporary backlog (`we:scripts/__tests__/check-backlog-item.test.mjs:41`); preserve that harness.

Acceptance is canonical, with Done when retained as a legacy alias by `we:scripts/backlog/task-agreement.mjs:29`. Reuse that shared heading matcher and heading scanner; do not introduce a Done-when-only dialect. Existing warning rules retain their behavior. `we:scripts/check-standards-rules.mjs:1182` conflates an untriggered refusal predicate and a triggered card with no lexical gaps as an empty array: factor the trigger privately rather than using a nonempty gap list as the applicability test.

Size remains 3. Estimated touch set: rules about 140 changed lines, content-lint tests about 180, enforcement contract about 6, conformance tests about 15, and scoped CLI tests about 55 (about 396 total). The engine hook at `we:scripts/check-standards-rules.mjs:1385`, existing temporary CLI harness, and generic contract-export checks in `we:scripts/lib/__tests__/check-standards.conformance.test.mjs:85` bound this to one detector and its tests. No estimatedLoc is added to this story. Preparation stamps are left for the runner.

## Design

1. Add a pure, line-reporting structural detector to `we:scripts/check-standards-rules.mjs`, composed by `lintBacklogItemRendering`. Reuse the heading scanner from `we:scripts/backlog/task-agreement.mjs`; scan instruction lines outside backtick/tilde fences, HTML comments, and blockquotes, preserving body line numbers. Recognize dated Operator ruling headings, Fix headings, and embedded `Fix:` instructions. A ruling must leave a single current plan: implement the review's explicit fallback of exactly one nonempty `## Plan`, designated authoritative, with prior Design/Fix instruction sections explicitly marked History or Superseded and pointing to that Plan. Permit rewriting by replacing the old instructions with that Plan. Do not claim to determine semantic agreement between arbitrary prose and a ruling. Preserve the ruling text as provenance; a later ruling requires reconciliation of the current Plan again through review.
2. Report unreconciled ruling structure as an error for unresolved cards with an Operator ruling. For unresolved build cards already derived as Tier A, reject TODO or empty Must entries and an absent, empty, or TODO executable Done-when criterion. For other unresolved build cards, surface the same readiness gaps as warnings so preparation remains possible. Build cards here are stories and tasks; resolved/closed history and decision cards are outside the build-readiness check. Missing or unknown tier metadata on an unresolved build card is an actionable readiness-evidence error, not a warning-only draft; the repair is to restore loader-readable metadata and rerun the scoped CLI. Known non-A tiers retain warnings. The existing tier is the readiness input; do not infer readiness from a word in the body.
3. Check Must entries in their actual authored homes: Must sections, bold Must groups under MVP/Explicit MVP cut, and labelled Must bullets in Test plan. Ignore quoted/fenced historical placeholders. When the existing guard-relaxation predicate identifies refusal-loosening work, require substantive error-path and non-code Must entries, explicitly covering docs, config, and data. Reuse its trigger without broadening it into semantic classification; collect the required Must evidence across those sections instead of relying on lead-text keyword presence. Other work needs its own substantive Must criteria but is not required to invent a refusal policy.
4. An executable criterion is a non-placeholder named command/test plus a stated expected outcome in Acceptance (or its legacy Done when alias); inspect it as text and never execute a card-supplied command during lint. Diagnostics identify the card, offending line, and repair. Add an enforced flag mirrored in `we:scripts/check-standards.contract.json` and pin it through the existing conformance machinery. Keep existing warning rules, executable-placeholder enforcement, and their settings intact; the new flag defaults to true and gates the new hard findings. A false flag demotes those findings to warnings, never suppresses them. An absent/empty body cannot supply required readiness evidence. Placeholder detection covers empty values and standalone TODO/TBD/scaffold text, not incidental discussion of those words in substantive criteria.

## MVP

- **Must 1:** one pure structural detector and shared-lint integration in `we:scripts/check-standards-rules.mjs`, covering ruling reconciliation, unfinished Must entries, and executable acceptance criteria with the applicability above.
- **Must 2:** enforcement declaration in `we:scripts/check-standards.contract.json`, pinned by `we:scripts/lib/__tests__/check-standards.conformance.test.mjs`.
- **Must 3:** regression fixtures in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` and subprocess wiring coverage in `we:scripts/__tests__/check-backlog-item.test.mjs`. Use synthetic card text; do not repair unrelated live cards or implement the cited runtime change.
- **Must on error:** ambiguous or incomplete reconciliation produces an actionable finding; lint treats executable text as data, including malformed or shell-like content.
- **Must for non-code:** docs, config, and data criteria receive the same structural validation as source-code criteria; file type does not exempt a card.

## Test plan

- Capability (RED today): a ruling with live Fix instructions fails; cover both a Fix heading and the incident's embedded `Fix:` line. A Plan without an explicit history/supersession marker, an empty Plan, and duplicate Plans also fail. Extend `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`.
- Capability (RED today): Tier-A stories with missing/empty Must criteria, TODO Must bullets in each supported location, or missing/empty/TODO Executable acceptance fail. Refusal-relaxation fixtures with only one required Must fail; fully populated error and docs/config/data criteria are accepted. Assert exact finding category and line, not total unrelated warning count.
- Preservation (passes on both): a rewritten single authoritative Plan with prior instructions removed, or one with older sections explicitly marked History/Superseded, is accepted. Mutation proof: restore an unmarked older Fix instruction and require rejection. Include a dated ruling and multiple historical rulings with one reconciled Plan.
- Preservation (passes on both): resolved cards, non-ready drafts, decisions, fenced examples, and blockquoted historical TODO text do not acquire hard readiness errors. Mutation proof: make the draft Tier A or move the placeholder into a live Must entry and require rejection. Parameterize source, docs, config, and data; command-like fixture text must create no subprocess or filesystem side effect.
- Capability (RED today): migrate existing synthetic unresolved story/task fixtures to explicit known non-A tiers when they represent drafts; retain a dedicated missing-tier fixture to prove the closed path. Do not weaken existing assertions. Extend `we:scripts/__tests__/check-backlog-item.test.mjs` with an invalid synthetic ruling card that exits nonzero, then rewrite it into the reconciled shape and require success. Clean up the temporary card through the existing harness. Verify whole-repo and scoped callers expose the shared diagnostic. Extend `we:scripts/lib/__tests__/check-standards.conformance.test.mjs` as needed to pin the new flag; mutation proof flips the engine flag alone and makes conformance fail.

## Proof plan

Run the three scoped Vitest suites by their repo-relative paths from the WE root: `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, `we:scripts/__tests__/check-backlog-item.test.mjs`, and `we:scripts/lib/__tests__/check-standards.conformance.test.mjs`. Record the named new assertions failing on the base and passing on the implementation; current positive controls are not red-to-green evidence.

Use the actual scoped CLI subprocess test to prove exit behavior, not only the pure detector. Through the same heavy-run queue, run `npm run check:standards` and record any pre-existing corpus findings separately from the new guard's findings. Inventory newly flagged live cards before claiming a green rollout; do not silently weaken enforcement or bulk-edit their decisions to obtain green. No live GitHub writes or runtime review dispatch are required for this guard.

## Acceptance

**Execution convention:** commands below run through the host heavy-run queue at `we:scripts/readiness/heavy-admission.mjs` (`run --wait-ms=60000 --`), from the WE root. Strip the documentary `we:` prefix from path arguments. Wait once if busy, then report the blocker.

**Executable:** from the WE root, run `npx vitest run` with the three suite paths listed in Proof plan (remove the documentary `we:` prefix when passing paths to the shell), then `npm run check:standards`. Musts 1–3 are satisfied when the new regression assertions fail on the base, pass after implementation, the CLI rejects the invalid card and accepts the reconciled card, and contract conformance pins enforcement. Record the actual outputs and any corpus blockers; an unrun command is not completion evidence.

- [A1] **Executable** — `npx vitest run we:scripts/__tests__/check-standards-rules-content-lint.test.mjs -t "4766 ruling reconciliation"`: add that named parameterized test for missing/empty/duplicate authoritative Plans, dated/multiple rulings, live heading and embedded Fix instructions, and positive rewritten/history-marked controls. Negative assertions fail before implementation and pass after; assert card id, body line, and repair. Covers Must 1.
- [A2] **Executable** — `npx vitest run we:scripts/__tests__/check-standards-rules-content-lint.test.mjs -t "4766 readiness evidence"`: add that named test for empty bodies, missing/unknown tiers, Tier-A missing/empty/TODO Musts in every supported home, and missing/empty/placeholder executable criteria under both heading aliases. Assert errors for incomplete ready cards, warnings for known non-A drafts, and no new readiness findings for resolved/closed or decision cards. The negative assertions fail before and pass after. Covers Must 1 and Must on error.
- [A3] **Executable** — `npx vitest run we:scripts/__tests__/check-standards-rules-content-lint.test.mjs -t "4766 refusal evidence and inert history"`: add that named test pairing rejection of triggered cards with incomplete error-path/docs/config/data Musts with acceptance of complete criteria. Include a trigger with lead-region lexical gaps already satisfied, source/docs/config/data scopes, backtick/tilde fences, HTML comments, quotes, and shell-like acceptance text with no side effects. Rejection assertions fail before and pass after; controls remain green. Covers Must 1 and both non-numbered Musts.
- [A4] **Executable** — `npx vitest run we:scripts/__tests__/check-backlog-item.test.mjs -t "4766 shared caller diagnostics"`: add that named subprocess test using the temporary backlog, checking nonzero exit for an unreconciled ruling and incomplete Tier-A criteria, then zero after reconciliation/completion. Compare the emitted shared diagnostic, and exercise unreadable frontmatter and the missing-tier fallback without claiming readiness. Rejection assertions fail before and pass after. Covers Must 3; existing caller wiring remains unchanged.
- [A5] **Executable** — `npx vitest run we:scripts/lib/__tests__/check-standards.conformance.test.mjs -t "4766 enforcement default"`: add that named assertion requiring the new contract flag and engine export to exist and equal true. It fails before and passes after; mutating the engine flag alone fails existing value conformance. Also run `npx vitest run we:scripts/__tests__/check-standards-rules-content-lint.test.mjs -t "4766 enforcement severity"`; add that named case asserting false demotes new errors to visible warnings while preserving old placeholder enforcement and warning rules. Covers Must 2 and the changed default.

## Non-goals

- [N1] Semantic adjudication of operator rulings, runtime referral changes, dispatch changes, new lifecycle states, and bulk reconciliation of existing cards.

## Follow-ups

Reconcile the cited card's runtime plan in its own implementation lane under its operator ruling; this guard only establishes an explicit authoritative plan and complete criteria. Any corpus migration discovered by the gate needs its own bounded touch-set, not an undeclared expansion here. Semantic consistency between a Plan and the operator's words remains a reviewer obligation. These follow-ups are not filed as separate items during preparation.
