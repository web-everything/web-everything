---
bornAs: xupgrcq
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/probation-launcher.mjs", "we:scripts/lib/__tests__/probation-launcher.test.mjs", "we:scripts/lib/antigravity-run-evidence.mjs", "we:scripts/lib/__tests__/antigravity-run-evidence.test.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/__tests__/review-extra-seats.test.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/__tests__/cli-adapter.test.mjs", "we:scripts/operations/__tests__/cli-adapter-evidence.test.mjs", "we:scripts/gemini-direct-task.mjs", "we:scripts/__tests__/gemini-direct-task.test.mjs", "we:scripts/lib/__tests__/model-probation-graduation.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-10-02"
preparedAgainstSha: "a770bdad0ced4c8304349bd4476eeea4befd0f97"
tags: []
---

# Prevention — Preserve configured probation model identity and harden Antigravity evidence boundaries

Filed from the approval of chalbert/web-everything#3227: keep registry identity separate from reported provenance, and cover the quota, mismatch, hold-file and caller boundaries that the approval left as prevention debt.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3227@b0b5ce6ed97312e7254723dbf494aa3e3d6f2d8e

## Progress

Preparation research confirmed the goal is not already delivered. The old premise named four implementation files, cited outdated line positions, omitted the judge adapter and direct-task resume owner, and named the nonexistent integration test `we:probation-build-run.test.mjs`. The corrected scope retains all seven prevention obligations, adds the actual boundary owners and matching tests, and uses the existing `we:scripts/operations/__tests__/probation-build-run.test.mjs`. The new `we:scripts/operations/__tests__/cli-adapter-evidence.test.mjs` is planned; all other scoped tests exist. Model grouping needs a regression in the existing `we:scripts/lib/__tests__/model-probation-graduation.test.mjs`, not a grouping algorithm change.

Source evidence and corrected locations:

- `we:scripts/lib/probation-launcher.mjs:404` (`launchScorecardRow`) still sets Antigravity `model` from evidence at line 409. `we:scripts/lib/model-probation.mjs:459` (`graduationProgress`) groups by provider/model/taskType. A direct Node probe with empty evidence returned `model: unknown` alongside the configured `requestedModel`.
- `we:scripts/lib/antigravity-run-evidence.mjs:9` still recognizes generic quota prose/429, permits overflow in reset arithmetic, and excludes short aliases from its same-backend model comparison. Direct probes classified unrelated 429 text as exhausted, accepted requested sonnet/reported Claude Opus, and threw `RangeError: Invalid time value` for a 310-digit hour count.
- `we:scripts/lib/antigravity-run-evidence.mjs:28` parses hold files inside one outer try and spreads the selected row without `pickAgyEvidence`; one malformed JSON file can abort the scan and arbitrary keys can escape.
- `we:scripts/operations/cli-adapter.mjs:891` owns the graceful `createDefaultJudge` catch; `we:scripts/operations/cli-adapter.mjs:1013` owns the `driveRun` catch and persisted telemetry. These were absent from the original scope.
- `we:scripts/operations/review-extra-seats.mjs:424` owns `classifySeatCall`; the mismatch rejection already exists. Resume suppression already exists separately in `we:scripts/gemini-direct-task.mjs:550`, so this obligation is boundary coverage, not a new retry policy.
- `we:scripts/operations/probation-build-run.mjs:780` owns `realIo.runWorker`: it parses complete stdout, returning empty evidence on formatted non-JSON output. Its private `trySh` is not injectable. Use the temporary executable fixture pattern already present in `we:scripts/operations/__tests__/probation-build-run.test.mjs:733`, rather than promising a mock of an inaccessible helper.
- `we:scripts/lib/__tests__/antigravity-run-evidence.test.mjs:71` already covers successful adapter/seat/launch provenance, but expects the launch model to equal the served model; update only that launch expectation. Existing judge and review-seat model semantics are not the probation registry-key defect.

## Design

1. In `we:scripts/lib/probation-launcher.mjs`, always set the scorecard `model` to `worker.model`. Keep reported identity exclusively in the separate provenance fields, with configured requested-model fallback and unknown/unavailable served evidence when parsing yields nothing. Whitelist incoming provenance using the existing helper so it cannot overwrite registry identity or unrelated row fields. Do not change graduation grouping or rewrite historical rows.
2. In `we:scripts/lib/antigravity-run-evidence.mjs`, recognize quota exhaustion only from diagnostic lines beginning (after whitespace) with the `RESOURCE_EXHAUSTED` token or `Individual quota reached` phrase, with token boundaries and optional diagnostic suffixes. Continue reading stderr and terminal error only, never answer/prompt/tool text. Preserve the one-hour fallback for absent/zero reset durations; cap positive durations at seven days, including overflow. Validate the timestamp before ISO conversion; invalid clock input yields a null reset timestamp while retaining the refusal decision.
3. Parse hold files independently: ignore malformed JSON, invalid row shapes and invalid/expired reset timestamps, retain the latest valid active hold, and whitelist its fields before applying not-launched overrides. Preserve backend isolation and default-model conservative lookup. Unexpected filesystem errors still surface; malformed contents do not suppress a valid sibling hold.
4. Normalize recognized short aliases `sonnet` and `opus` to their Claude model families for comparison, refusing cross-family substitution in both directions. Keep explicit versioned-model comparison and existing effort-suffix normalization; do not broaden unknown aliases into verified identities. Missing init stays unknown/unavailable under the existing behavior.
5. Exercise the actual caller boundaries in `we:scripts/operations/probation-build-run.mjs`, `we:scripts/operations/cli-adapter.mjs`, `we:scripts/operations/review-extra-seats.mjs`, and `we:scripts/gemini-direct-task.mjs`. Preserve current skip/rethrow/resume behavior while proving evidence reaches the stored result. Change those source files only if the new boundary tests expose evidence loss.

## MVP

Deliver configured launch identity, defensive quota/hold parsing, short-alias mismatch refusal, and the boundary regressions together. No new dependencies or live provider calls are needed. The acceptance surface is the produced launch row, graduation grouping, persisted judge telemetry, classified seat result and subprocess invocation count. General helper linting and a stricter missing-init merge policy were optional suggestions in the filing; neither is needed to implement these existing obligations.

## Test plan

- `we:scripts/lib/__tests__/probation-launcher.test.mjs`: empty evidence, reported differing model, effort-suffix model and extraneous evidence keys must all preserve `worker.model`; configured requested fallback and served unknown defaults remain explicit. Include a non-Antigravity control.
- `we:scripts/lib/__tests__/model-probation-graduation.test.mjs`: compose actual launch rows with empty versus parsed evidence, feed them to `graduationProgress`, and assert one configured provider/model/taskType group with unchanged registry status and counts, not an unknown-model group.
- `we:scripts/lib/__tests__/antigravity-run-evidence.test.mjs`: deterministic tables for anchored diagnostic positives; generic 429/rate-limit/quoted prose negatives; missing, zero, normal, oversized and overflowing delays; invalid clock; malformed and extra-key hold files beside a valid hold; expiry and backend isolation. Table-test sonnet/opus matching families and substitutions in both directions, explicit versioned models, effort suffixes and unavailable init. Add a bounded seeded arbitrary-stderr corpus asserting no throw and only valid-or-null reset timestamps. Update the existing launch expectation while preserving judge/seat expectations.
- Planned `we:scripts/operations/__tests__/cli-adapter-evidence.test.mjs`: inject a provider throwing evidence-bearing errors through `createDefaultJudge` and assert skipped outcome plus whitelisted telemetry. Inject a throwing judge into `driveRun` with an in-memory store and minimal judge operation; assert telemetry was written before the same error is rethrown, with no arbitrary report keys persisted. Cover errors without telemetry as controls.
- `we:scripts/operations/__tests__/review-extra-seats.test.mjs`: model/backend mismatch reports with otherwise valid verdict JSON must classify as error; matching identity stays eligible, and exhausted quota retains precedence.
- `we:scripts/__tests__/gemini-direct-task.test.mjs`: use injected subprocess events, conversation ID and timeout/nonterminal failure to make resume otherwise eligible; quota and either mismatch decision must suppress the second spawn. Retain a normal interrupted-run control that resumes once.
- `we:scripts/operations/__tests__/probation-build-run.test.mjs`: run the real `realIo.runWorker` against a temporary local executable emitting formatted text, then use that result in the existing fake-IO `runProbationBuild` harness and capture `appendScorecard`. Assert the actual row retains configured model/requestedModel with unavailable served evidence. Add valid JSON stdout as the provenance-preserving control. Stub all lane, git, gate and publication operations; no external mutation.

## Proof plan

Implementation proof must first demonstrate red regressions for empty-evidence launch identity, short-alias substitution, overflow and malformed sibling holds, then show them passing after the fix. Run the seven scoped test files using `npx vitest run` with their corresponding repository-relative arguments (the complete prefixed file list is in Test plan). Inspect the captured scorecard row and stored catch-path telemetry, not only helper returns. Prove resume suppression by subprocess call count. Finish with `npm run check:standards`; record commands, exit status and observed assertions. Preparation's direct probes above establish current defects only; they are not a claim that the future implementation or tests pass. The runner owns preparation stamping and checks.

## Done when

1. The Test plan's regression suite passes and `npm run check:standards` passes after implementation; reverting the identity/parser fixes makes their regression cases fail.
2. Unparsed runs remain grouped under the configured registry model without inventing served identity; parsed provenance stays separate.
3. Malformed diagnostics and hold files cannot throw a date/JSON parsing error or leak unrelated fields, and a valid active sibling hold still prevents launch.
4. Recognized model substitutions remain refused through seat classification and cannot trigger resume; judge failure telemetry survives its actual catch boundaries.

## Follow-ups

A general exported-helper call-site lint is outside this bounded prevention change; the explicit boundary tests provide the guard here. Strict missing-init rejection for merge-gating seats would change policy and requires a separate decision if pursued. Historical scorecard migration and changes to judge/review-seat `model` semantics are not part of the configured probation worker identity fix. No follow-up is required to satisfy the MVP.
