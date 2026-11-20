---
bornAs: x2l32m7
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/backlog.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs", "we:scripts/__tests__/backlog-prepare-stamp-status.test.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/operations/prepare-stamp-land.mjs", "we:scripts/operations/__tests__/prepare-stamp-land.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "a428099b6538c0a203609c812e354ae1e0e3160c"
tags: []
---

# Prevention — Add a check:standards or prepare-stamp gate: any card stamped with preparedAgainstSha must contain a ##… (from chalbert/web-everything#3261 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4378-plateau-credential-inventory-and-rotation-tracker.md:135` — Add a check:standards or prepare-stamp gate: any card stamped with preparedAgainstSha must contain a `## Done when` heading with at least one numbered clause. A cheaper first step is to have the probation launcher fail fast when the section is missing.
2. `we:backlog/4378-plateau-credential-inventory-and-rotation-tracker.md:53` — Cite symbols (historical `ghDue` citation; current collector home is `we:scripts/conveyor/health-watch.mjs`) rather than line numbers, or have prep-staleness check file:line citations against preparedAgainstSha.
3. `we:backlog/4378-plateau-credential-inventory-and-rotation-tracker.md:126` — Add a rule to the health-smell and collector test conventions that every free-text field emitted from external API data passes a shared sanitize-and-truncate helper. A unit test should assert that control characters are stripped.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3261@266ed3c23aa679d9811897a534eef420866b50bb

## Progress

- **Premise correction (2026-11-19).** The old preparation asserted that no placeholder detector existed and required only a literal Done-when heading with decimal-numbered clauses. Current evidence: `we:scripts/check-standards-rules.mjs:1447` already errors on an open, preparedDate-stamped scaffold placeholder when executable acceptance policy is enabled; the adjacent #4738 rule also rejects that placeholder beside a proof claim. Neither supplies the missing-section check. `prepareStamp` at `we:scripts/backlog.mjs:610` still writes the stamp without reading acceptance. This item is not already delivered.
- **Format correction.** `we:scripts/backlog/task-agreement.mjs:21` defines canonical Acceptance and legacy Done-when, and its skeleton at line 54 emits `[A1]` clauses. Reuse this reader instead of introducing a Done-when-only parser that rejects current scaffolds. Its legacy prose fallback is not sufficient evidence of a numbered clause: explicitly require a real list clause for this gate.
- **Scope correction.** The supplied scope already names the eight implementation/test files rather than the reviewed card. Keep that touch set; the shared agreement reader and loader are dependencies, not planned edits. `we:src/_data/backlog.js:454` spreads frontmatter into the item, including kind and preparedAgainstSha, so the proposed loader addition is unnecessary. The intro's three reviewed-card line citations are historical review locations, not current implementation locations.
- **Caller correction.** `we:scripts/operations/probation-build-run.mjs:275` checks preparation sections/test scope, then invokes the stamp; lines 702–709 retry a refusal once before returning prepare-unstamped. `we:scripts/operations/prepare-stamp-land.mjs:50` invokes the stamp and propagates rejection through cleanup; its CLI catch emits failed. The old promise that neither caller throws was inaccurate: the recovery function intentionally rejects.
- **Sizing.** Retain story size 3: two gate/CLI sources approximately 70 changed lines each, two caller sources up to 15 each for diagnostic adjustments if needed, and four existing test files approximately 40–70 each (about 330–450 changed lines). No estimatedLoc is appropriate for this story. Preserve the supplied stamp for runner ownership; this edit does not re-stamp.
- The former corpus count (24/286) and assertion that this card itself still contained scaffold acceptance are stale and removed. No live stamp or before/after test result is claimed during preparation.

## Design

Add the pure `findDoneWhenGaps(body)` detector in `we:scripts/check-standards-rules.mjs`, implemented using `readTaskAgreement` and the fence/comment-aware heading reader from `we:scripts/backlog/task-agreement.mjs`. Accept canonical Acceptance with `[A<n>]` list clauses and legacy Done-when with decimal-numbered clauses. Only visible list clauses in the selected acceptance section count; prose alone, fenced examples, comments, empty text, duplicate sections/IDs, draft agreement markers and unfinished TODO clauses are incomplete evidence. Canonical heading selection follows the shared reader; a valid legacy section must not rescue an invalid canonical one. Ignore non-goals-only problems: this item does not introduce a non-goals gate.

Return stable gap kinds (missing-section, no-numbered-clause, placeholder-clause, invalid-acceptance) with actionable diagnostics. An empty or non-string body fails closed. Reuse the reader's acceptance problems rather than judging whether prose commands really execute. The builder should add only the stricter visible-list check needed for the reader's permissive legacy prose fallback; do not fork the shared Markdown parsing rules.

Compose a warning into `lintBacklogItemRendering` for non-resolved story/task cards with a nonempty preparedAgainstSha. Keep existing executable-acceptance errors and their policy behavior unchanged. This warning covers legacy stamped cards without forcing their migration in this build.

At `prepareStamp` in `we:scripts/backlog.mjs`, run the same detector before mutation for story/task cards lacking a nonempty preparedAgainstSha. Refuse with a nonzero result, diagnostic and byte-identical file on a gap. The operator remedy is to author real acceptance and retry. Retain the prior preparation's explicit compatibility boundary: already-stamped cards can re-stamp; decision/epic stamping remains unchanged. This is a first-stamp guard plus a corpus warning, not a claim that all historical stamps become valid. Do not introduce a new setting or alter the shared task-agreement advise/enforce default.

Preserve caller contracts: the probation runner receives an unsuccessful stamp result, offers its existing single repair, then reports prepare-unstamped if still refused. Recovery landing rejects, releases its lane, and the CLI emits its existing failed record; neither path publishes a rejected stamp. Use existing dependency injection to test these paths without remote calls.

## MVP

**Must**
1. Implement shared acceptance-gap detection and the kind/status/stamp-scoped rendering warning, supporting both current and legacy numbered formats.
2. Guard first story/task stamping before any write, including empty, malformed, draft and placeholder acceptance; preserve status handling, valid stamping, re-stamps and decision/epic exemptions.
3. Exercise both stamp callers against refusal, preserving bounded repair, cleanup and no-publication behavior. Update the successful bare-body fixture in `we:scripts/__tests__/backlog-prepare-stamp-status.test.mjs:21` to real acceptance while retaining all status/idempotence assertions.

**Could**
- Promote the new warning to an error after a separately authorized corpus cleanup.

## Test plan

- **Capability (RED on base): detector matrix** in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`: missing section, empty/prose-only acceptance, placeholder among valid clauses, invalid IDs, duplicate sections, draft marker, non-string input, fenced/comment-only clauses, canonical-invalid plus legacy-valid, and valid canonical/legacy lists. Assert gap kinds; no Must section is required. The proposed export is absent on the base.
- **Capability (RED on base): lint matrix** in the same file: malformed acceptance warns on non-resolved stamped stories/tasks; unprepared, resolved, decision and epic records produce no new warning. Retain existing placeholder-policy errors. Pair positive and negative assertions so changing scope conditions fails the matrix.
- **Capability (RED on base): first-stamp matrix** in `we:scripts/__tests__/backlog-prepare-stamp-status.test.mjs`: subprocess stamp refuses missing, prose-only, scaffold, malformed and draft acceptance; compare full bytes before/after and assert diagnostic/nonzero exit. Include empty preparedAgainstSha as a first stamp. A valid canonical or numbered legacy body stamps successfully.
- **Preservation (GREEN on base): compatibility** in that CLI suite: valid active/preparing/parked/open/status-less cards retain existing status behavior and idempotence; a nonempty old preparedAgainstSha bypasses the new guard, and decision/epic cards remain stampable. Mutation check: removing the first-stamp or kind condition makes these cases fail.
- **Capability (RED on base): caller contract matrix** in `we:scripts/operations/__tests__/probation-build-run.test.mjs` and `we:scripts/operations/__tests__/prepare-stamp-land.test.mjs`: combine a real detector/CLI refusal fixture with the existing injected caller harness. Assert one repair then prepare-unstamped for repeated probation refusal, successful retry after acceptance repair, and recovery rejection plus lane release. Assert no commit/publish after terminal refusal. The base accepts the invalid fixture; merely injecting an arbitrary failure would be preservation, not red/green evidence.
- **Preservation (GREEN on base): existing caller error contracts** remain covered; mutation check: suppress the failed stamp result, remove release, or allow publication after refusal and the corresponding test must fail.

## Proof plan

The builder adds the named tests first and captures red results against the base, then green results after implementation. Use temporary CLI repositories under the task TMPDIR; do not stamp a real backlog item as a probe. Record the subprocess exit, diagnostic and full-file equality for each refusal. Run only the four scoped suites through the host heavy queue, followed by the queued standards gate. In commands, replace the documentation locus `we:` with a checkout-relative path before execution:

- `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run` with the four test paths in scope.
- `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards` for repository integration.

If admission is busy, use the queue's supported bounded wait once, then report the unrun check. Capture a warning from the deliberately invalid stamped lint fixture and no new warning from a valid fixture. Existing corpus warnings are an inventory for follow-up, not a reason to widen this change or claim an unmeasured count.

## Follow-ups

1. Review guard 2: independently scope symbol citations or file:line validation against preparedAgainstSha in `we:scripts/readiness/prep-staleness.mjs`; this build does not establish that the entire citation problem is still absent.
2. Review guard 3: independently investigate a shared sanitize-and-truncate requirement and control-character tests for external collector text, starting at `we:scripts/conveyor/health-watch.mjs`.
3. Inventory legacy stamped acceptance gaps, then separately decide whether to migrate them and promote the warning. No new blockedBy edge is proposed.

## Acceptance

- [A1] **Executable** — The detector/lint matrix in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, run through the queued Vitest command in Proof plan, fails before implementation and passes after: canonical and legacy numbered acceptance work; missing, unfinished, malformed, hidden and draft evidence fails closed; the warning applies only to the specified stamped story/task population (Must 1).
- [A2] **Executable** — The first-stamp and compatibility matrix in `we:scripts/__tests__/backlog-prepare-stamp-status.test.mjs`, run through the same queue, fails before implementation and passes after: invalid first stamps refuse with unchanged bytes; valid stamps succeed; old stamps, exempt kinds, statuses and idempotence preserve their behavior (Must 2).
- [A3] **Executable** — The real-refusal caller matrices in `we:scripts/operations/__tests__/probation-build-run.test.mjs` and `we:scripts/operations/__tests__/prepare-stamp-land.test.mjs`, run through the same queue, fail before implementation and pass after: bounded repair or terminal failure is observable, recovery releases its lane, and terminal refusal prevents commit/publication (Must 3).

## Non-goals

- [N1] Requiring non-goals, migrating historical cards, changing agreement policy defaults, implementing citation freshness, or sanitizing collector text.
