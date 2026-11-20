---
bornAs: x1vkzk7
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/run-scorecard-store.mjs", "we:scripts/lib/model-probation.mjs", "we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs", "we:scripts/lib/__tests__/model-probation-trials.test.mjs", "we:docs/agent/reviewer-expectations.md"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "280c9f8d5aaecf87303d48638a938473781b9ae3"
tags: []
---

# Prevention — Prove probation lock refusal, review freshness, and exact file-count boundaries

Filed from the prevention debt in chalbert/web-everything#3234. Preserve the four original obligations: lock-held refusal with an unchanged store; deterministic lock-failure mutation proof; stale merged-PR approval coverage; and complete scope at exactly 100 files. The first two are one regression plus its mutation proof. Also codify the requested review-lens rule linking refusal comments to named negative tests.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3234@8ebbd4bf827297b675e420b0c151eb442cee4b40

## Progress

- Original premise: tests alone at historical citations `we:scripts/conveyor/run-scorecard-store.mjs:340` and `we:scripts/conveyor/run-scorecard-store.mjs:342`, plus probation tests in `we:scripts/lib/__tests__/model-probation.test.mjs`. Corrected premise: the locking entry point is `appendScorecardUnlessJudged` at `we:scripts/conveyor/run-scorecard-store.mjs:350`; it forces `requireLock: true`, while injected `io.write` bypasses locking at line 372. Existing concurrency coverage at `we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs:413` does not assert acquisition failure.
- The real trial test home is `we:scripts/lib/__tests__/model-probation-trials.test.mjs:120`. It covers stale OPEN review-change labels and incomplete counts, but not stale MERGED acceptance or exact 100/100. Replace the generic registry test path in scope with this file.
- This is not already delivered: `we:scripts/lib/model-probation.mjs:408` derives reviewed solely from label presence; line 410 rejects every array of length 100. Small production corrections are required, not just more tests. Existing pending behavior at line 409 supplies the stale-approval disposition without a new policy choice. The caller at `we:scripts/lib/model-probation.mjs:441` uses the guarded append; positive merged fixtures at `we:scripts/lib/__tests__/model-probation-trials.test.mjs:78` and line 145 currently omit timestamps and must be made explicit.
- Widen scope to `we:docs/agent/reviewer-expectations.md:5` and line 8 for the original review-lens obligation. Keep size 3: approximately 10–20 changed source/comment lines in each of two source files, 40–60 lock-test lines, 70–100 trial-test/fixture lines, and 2–4 checklist lines (about 132–204 changed lines across five files). No estimatedLoc: this is a story.
- Preparation is source inspection only; no runtime probe or test pass is claimed. Stamping and checks remain runner-owned.

## Design

Keep the existing lock implementation. Exercise the public probation append with a real temporary store and live lock; do not inject `io.write`, which bypasses the branch under test. Seed valid bytes and use a distinct trial key so deduplication cannot conceal an unlocked write. Use a controlled clock advancing beyond the 5-second acquisition budget but below the 15-second stale-lock threshold, anchored to the actual lock mtime; restore it in finally. Assert the lock error, byte-for-byte unchanged store, and preserved holder lock. Cite this named test from the refusal doc comment. Ordinary append remains best-effort.

In `we:scripts/lib/model-probation.mjs`, require both acceptance-label presence and a valid `reviewLabelAt` strictly newer than valid `launch.scoredAt` before a landed trial is judged. Reuse the existing pending/no-append disposition for absent, malformed, equal, or older times. Leave pure merge/close outcome derivation unchanged. Historical launches missing timestamps remain pending; previously judged rows are not rewritten.

Determine file completeness from an explicit nonnegative integer `changedFiles` equal to the returned array length, including 100 and larger exact counts. Without a count, preserve the existing below-100 compatibility rule; an array of 100 or more without a count remains incomplete. Mismatched, invalid, or missing file evidence retains null scope and conservative critical-miss classification. Exact completeness does not exempt genuinely critical paths from classification.

Extend the existing fail-closed/test-each-guarantee checklist in `we:docs/agent/reviewer-expectations.md`: each changed doc-comment sentence promising refusal or fail-closed behavior must cite a named test that reaches the refusal branch. Apply the rule to the changed comments; a repository-wide comment rewrite is unnecessary.

## MVP

Must deliver the lock regression and mutation proof, stale-approval correction with caller fixtures, exact-count correction with conservative controls, and the review-lens rule. No new settings, default lock-mode changes, registry writes, migrations of judged history, or network-dependent tests are needed. Could later automate refusal-comment auditing; that is outside this bounded change.

## Acceptance

The names below are planned tests. Run them through the queue described in Test plan; do not treat a zero-test filter as success.

- [A1] Executable — `#4685 held lock refuses probation append without changing bytes` in `we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs` asserts throw, identical bytes, and retained lock. It passes with current locking, fails with only the probation helper's forced `requireLock` removed, and passes after restoration. The baseline deficiency is absent coverage, not broken locking.
- [A2] Executable — `#4685 merged acceptance must postdate launch` in `we:scripts/lib/__tests__/model-probation-trials.test.mjs` covers stale/equal/missing/invalid review times and missing/invalid launch times, asserting pending and zero appends, then fresh acceptance produces one verified row. The stale case fails on the pre-build implementation and passes after the correction.
- [A3] Executable — `#4685 exact count proves complete file scope` in `we:scripts/lib/__tests__/model-probation-trials.test.mjs` uses a fresh reworked verdict and 100 noncritical documentation paths with count 100: all paths survive and criticalMiss is false. Include 101/101, 99/no-count, 100/no-count, 100/130, invalid counts, missing arrays, and an exact-count critical-path control. Exact 100/100 fails before the correction; conservative cases must remain green.
- [A4] Executable — `#4685 runJudge preserves stale persisted launch until fresh approval` in `we:scripts/lib/__tests__/model-probation-trials.test.mjs` persists a launch and drives runJudge: stale approval leaves bytes and verified count unchanged, fresh approval appends once, another sweep adds nothing, and dry-run writes nothing. The stale leg fails before the correction. Update existing successful merged fixtures with explicit fresh times rather than weakening assertions.
- [A5] Executable — a text assertion using `node -e` checks that `we:docs/agent/reviewer-expectations.md` contains the exact new sentence “Every refusal or fail-closed doc-comment promise must cite a named test exercising its refusal branch.” and that the lock refusal comment in `we:scripts/conveyor/run-scorecard-store.mjs` names the A1 test. This assertion fails before the documentation change and passes afterward; it is a delivery check, not a new permanent documentation unit-test framework.

## Test plan

Run only the two affected suites through `we:scripts/readiness/heavy-admission.mjs`. For executable shell commands below, strip the repository prefix from the path arguments (the prefix identifies the repository, not a literal filename):

`node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs we:scripts/lib/__tests__/model-probation-trials.test.mjs`

First add the A2–A4 regressions and capture their expected failures against unchanged production code; then implement and run both suites. A1 must additionally kill the requireLock mutation. Use task TMPDIR for fixtures and restore clock mocks and temporary files even on assertion failure. Queue contention permits one bounded queue-owned wait, then report and stop. No full suite or real GitHub calls.

## Proof plan

Record named-test counts and red/green output for A2–A4. Record A1 passing normally, failing after removing only the helper's forced lock requirement, and passing after restoring it; verify unchanged store bytes are checked even when the throw assertion fails. Run A5's text assertion before and after the documentation edit. Review the final diff for changed defaults/callers: no best-effort lock default change, no historical row rewrite, and successful merged fixtures now carry fresh evidence. The independent reviewer checks that the new checklist sentence and refusal test citation agree. Run the queued standards gate during delivery, with path normalization as above: `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards`.

## Follow-ups

Optional separate work: automate review-comment-to-negative-test auditing across the repository. No follow-up is needed to complete the four original regressions or the requested review-lens rule; all are MVP obligations. No blockedBy changes proposed.
