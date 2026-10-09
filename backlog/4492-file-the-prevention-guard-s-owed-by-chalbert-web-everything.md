---
bornAs: x6zg9hx
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/hung-session.test.mjs", "we:scripts/conveyor/hung-session-mutation-check.mjs", "we:scripts/conveyor/__tests__/hung-session-mutation-check.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "dfe8b082a4e6a08541a3681e99d85b0db2b99e58"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2939's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/hung-session.test.mjs` — Require branch coverage or mutation testing on the `Date.parse` fallback logic to ensure parsed entries without timestamps are actually tested.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2939@2789b3efcec6d5140dcb54f4763b793752353d86

## Progress

- Original premise/scope: the approval advisory requested branch coverage or mutation testing for the `Date.parse` fallback, naming only we:scripts/conveyor/__tests__/hung-session.test.mjs.
- Corrected premise: this is prevention debt, not a demonstrated runtime bug. The timestamp scan now belongs to `readTranscriptTailActivity` in we:scripts/conveyor/hung-session.mjs:151-201 (extracted by commit `2789b3efcec6d5140dcb54f4763b793752353d86`). Its successfully summarized entries pass through `Date.parse(entry?.ts ?? '')`; only finite timestamps suppress the mtime fallback.
- Evidence: we:scripts/conveyor/__tests__/hung-session.test.mjs:217 already exercises a real JSON entry without a timestamp through `readHungInfo`. However, the direct shared-reader fallback case at we:scripts/conveyor/__tests__/hung-session.test.mjs:345 makes the summarizer throw, so it bypasses `Date.parse`. Existing direct clean-parse cases supply valid timestamps. The original debt is therefore narrower than “no fallback test”: require direct parsed-but-undated cases and prove their assertions detect regressions.
- The previous preparation recorded a read-only runtime probe of the shared reader with injected IO returned `lastActivityMs: 12345`, preserved the entry, reported `hadUnparseableLine: false`, and called stat once for both an omitted timestamp and an invalid timestamp. This confirms existing behavior, not completion of the prevention guard.
- Corrected scope: retain we:scripts/conveyor/__tests__/hung-session.test.mjs and add a bounded executable mutation checker at we:scripts/conveyor/hung-session-mutation-check.mjs with its matching unit tests at we:scripts/conveyor/__tests__/hung-session-mutation-check.test.mjs. The runtime source is a read-only mutation target; no production behavior change is planned. The existing executable/checker-test pairing in we:scripts/conveyor/guard-1c-mutation-check.mjs and we:scripts/conveyor/__tests__/guard-1c-mutation-check.test.mjs supplies the local implementation pattern.

- Current-checkout revalidation: we:scripts/conveyor/hung-session.mjs:190-198 and we:scripts/conveyor/__tests__/hung-session.test.mjs:217,345 still support that correction. File discovery finds neither the proposed checker nor its matching test, and the named regression group is absent from the existing suite; this guard is not already delivered. Retain the three-file scope and size 3. The checker source has its planned matching test explicitly in scope; the existing reader test is itself a test entry, and the runtime remains read-only.
- Implementation-pattern correction: we:scripts/conveyor/guard-1c-mutation-check.mjs:70-89 checks an aggregate baseline count and filters whichever mutant assertions happen to be present. That is useful scaffolding, but does not prove a complete named case set. Its subprocess at we:scripts/conveyor/guard-1c-mutation-check.mjs:116-119 also bypasses the host queue. The new checker must validate an explicit case manifest for every run and route its real test subprocesses through we:scripts/readiness/heavy-admission.mjs. No broader scope or dependency change is needed.

## Design

Use targeted mutation testing, one of the advisory's explicitly permitted guards. Add a named `Parsed timestamp fallback` group in we:scripts/conveyor/__tests__/hung-session.test.mjs that calls the exported shared reader with deterministic injected IO. Summarization must succeed: missing, null, empty, and invalid timestamps remain entries and do not set `hadUnparseableLine`. With no valid timestamp, the reader uses the exact injected mtime; with a valid timestamp among undated entries, it uses the greatest valid timestamp and never calls stat.

Implement we:scripts/conveyor/hung-session-mutation-check.mjs following the existing bounded checker pattern, without changing its unrelated predecessor. Run the named tests unmodified first, then against uniquely named sibling copies of we:scripts/conveyor/hung-session.mjs selected through a temporary Vitest alias. Never overwrite the original source. Use exact-once replacement guards and structured assertion results; missing tests, skipped tests, missing reports, load errors, and surviving mutants are failures, not successful kills. Clean temporary source/config/report artifacts in `finally`.

Use a fixed manifest of case suffixes beneath the named group: `omitted`, `null`, `empty`, `invalid`, `stat-error`, `mixed-forward`, and `mixed-reverse`. Each report must contain each required full name exactly once from we:scripts/conveyor/__tests__/hung-session.test.mjs. All seven must pass at baseline. Every mutant must retain all seven results without skips; the designated kill cases below must fail with assertion evidence. Reject duplicate names, reports from another file, runner errors, signals, and collection errors even if some expected assertions failed. Capture process status alongside the JSON report; an expected failed-test exit alone is insufficient evidence.

For mixed cases, include two distinct valid timestamps and undated entries, reversing their order between cases; use an mtime distinct from both valid timestamps. For the all-undated cases use a nonzero mtime. This makes both timestamp preference and maximum selection observable.

Require these independent mutants to be killed by their designated cases:

1. Replace `Date.parse(entry?.ts ?? '')` with `Date.parse(entry?.ts ?? '1970-01-01T00:00:00.000Z')`: omitted/null timestamps wrongly become activity at epoch zero. The omitted and null timestamp cases must fail.
2. Replace `lastActivityMs = statFn(file).mtimeMs;` with `lastActivityMs = 0;`: the `omitted`, `null`, `empty`, and `invalid` cases must fail their exact mtime assertions (the `stat-error` case is not an exact-mtime assertion).
3. Replace `if (lastActivityMs === null) {` with `if (true) {`: mixed valid/undated cases must fail because stat is consulted despite a valid timestamp.

Each search must match once in the current target. The real test runner invokes Vitest through we:scripts/readiness/heavy-admission.mjs, inheriting its environment; nested admission is re-entrant as documented at we:scripts/readiness/heavy-admission.mjs:88-91. The checker exports an injected runner for unit testing and has a CLI returning nonzero on failure. This stays a local, reproducible guard; global coverage thresholds and runtime liveness policy are outside this item.

## MVP

1. Add the named table-driven cases to we:scripts/conveyor/__tests__/hung-session.test.mjs, including mixed entries in both orders and stat failure when all entries lack usable timestamps.
2. Add the three-mutant CLI and report validation in we:scripts/conveyor/hung-session-mutation-check.mjs. Require every designated baseline case by stable name, not merely a positive aggregate test count.
3. Add injected-runner tests in we:scripts/conveyor/__tests__/hung-session-mutation-check.test.mjs covering success and every refusal described below.
4. Run the real checker end to end and retain its baseline/kill output as delivery evidence.

## Test plan

- In we:scripts/conveyor/__tests__/hung-session.test.mjs, assert exact activity time, retained entries, false `hadUnparseableLine`, and stat call count for omitted/null/empty/invalid timestamps. Assert null when stat throws. Mixed valid/undated fixtures in either order must preserve the greatest valid timestamp and make zero stat calls.
- In we:scripts/conveyor/__tests__/hung-session-mutation-check.test.mjs, inject source text and reports to cover all mutants killed, a survivor, a no-op mutant, absent/duplicate replacement targets, failed baseline, missing/skipped designated cases at baseline and under each mutant, duplicate names, wrong-file reports, empty or malformed reports, runner errors/signals, and suite-load failures even alongside failed assertions. Require assertion failures on the designated cases, never a subprocess error alone.
- Through the host heavy-run queue at we:scripts/readiness/heavy-admission.mjs, run Vitest against we:scripts/conveyor/__tests__/hung-session.test.mjs and we:scripts/conveyor/__tests__/hung-session-mutation-check.test.mjs, then execute the checker through the same queue with Node using we:scripts/conveyor/hung-session-mutation-check.mjs as the entry point. Run the repository standards gate through the same queue for the implementation diff. Inject subprocess and filesystem adapters in checker tests to verify command wrapping and cleanup on success, malformed reports, and thrown runner errors without spawning nested Vitest.

## Proof plan

The executable acceptance command uses the host heavy-run queue at we:scripts/readiness/heavy-admission.mjs to run Node with we:scripts/conveyor/hung-session-mutation-check.mjs as its entry point. After implementing the checker but before adding the named regression cases, it must exit nonzero because required baseline cases are absent. With the complete implementation, it must exit zero and report the passing baseline plus three independently killed mutants.

Capture the exact named assertion failures for each mutant, then rerun the unmodified suite green. Confirm the original we:scripts/conveyor/hung-session.mjs is byte-identical before and after the real checker and that temporary artifacts are removed. A green ordinary suite alone does not satisfy this debt; the executable must demonstrate mutation sensitivity. Preparation's read-only probe above does not substitute for this delivery proof.

## Done when

The named parsed-entry cases pass, all three mutants are killed by the designated assertions, the checker refuses incomplete/invalid evidence, its matching tests pass, and the real run leaves the runtime source unchanged.

## Follow-ups

Preparation changes only this card; the runner owns stamping and checks. No new blockedBy edges are proposed. No prerequisite policy decision remains: mutation testing was explicitly authorized by the advisory. Broader mutation infrastructure or CI-wide coverage enforcement can be considered separately; neither is required to deliver this bounded prevention guard. If runtime behavior changes during implementation, revalidate this plan and declare the runtime source alongside its existing matching test in scope before changing it.
