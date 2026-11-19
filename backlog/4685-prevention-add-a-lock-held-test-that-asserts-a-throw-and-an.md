---
bornAs: x1vkzk7
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/run-scorecard-store.mjs", "we:scripts/lib/model-probation.mjs", "we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs", "we:scripts/lib/__tests__/model-probation-trials.test.mjs", "we:docs/agent/testing.md"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "781dec0e23810288560e3992187a41e4f72ca4b4"
tags: []
---

# Prevention — Prove probation lock refusal, review freshness, and complete file scope

Prevent probation evidence from being written without its lock, credited from a stale accepted review, or classified as incomplete solely because a fully enumerated PR has exactly 100 files. Preserve the original review debt from chalbert/web-everything#3234, including the reusable rule connecting refusal comments to negative tests.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3234@8ebbd4bf827297b675e420b0c151eb442cee4b40

## Progress

- Original premise: four test-only debts, with two duplicate lock-refusal requests at old lines 340/342 of we:scripts/conveyor/run-scorecard-store.mjs and probation tests assigned to we:scripts/lib/__tests__/model-probation.test.mjs. Corrected premise: the lock implementation already requires a lock at we:scripts/conveyor/run-scorecard-store.mjs:350-373, but the two probation guarantees need implementation fixes at we:scripts/lib/model-probation.mjs:408-412. The relevant existing suite is we:scripts/lib/__tests__/model-probation-trials.test.mjs:110-160. Consolidate the duplicate lock requests into one real-filesystem regression plus mutation proof.
- Evidence: we:scripts/lib/model-probation.mjs:335 returns `landed` before checking timestamps; line 408 treats label presence alone as reviewed. Existing freshness cases at we:scripts/lib/__tests__/model-probation-trials.test.mjs:114 cover open `review:changes`, not merged acceptance. The missing-timestamp success fixtures at lines 74 and 140 must explicitly acquire fresh evidence, not have their assertions weakened.
- Evidence: we:scripts/lib/model-probation.mjs:410 rejects every list of length 100. Existing incomplete-scope cases at we:scripts/lib/__tests__/model-probation-trials.test.mjs:125 cover 100/unknown, 100/130, and 2/3, but omit 100/100. No public `complete` result exists: completeness is observable as retained `changedFiles`/`filesTouched` and the real critical-miss verdict.
- Evidence: we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs:413 covers concurrent successful append/deduplication, not lock refusal. The real lock lives in we:scripts/conveyor/infra-blocked.mjs:571-601; the wrapper at we:scripts/conveyor/run-scorecard-store.mjs:231 delegates to it. Explicit `io.path` skips migration at we:scripts/conveyor/run-scorecard-store.mjs:279; `io.write` would bypass the append lock at line 372 and is unsuitable for this regression.
- Scope correction: retain both source modules and the store suite; replace the generic probation suite with the trials suite; add we:docs/agent/testing.md for the originally requested class-level review rule. No lock-helper production change is needed. Keep story size 3: approximately 8 source/comment lines in we:scripts/conveyor/run-scorecard-store.mjs, 15 in we:scripts/lib/model-probation.mjs, 40 test lines in we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs, 90 in we:scripts/lib/__tests__/model-probation-trials.test.mjs, and 8 guideline lines in we:docs/agent/testing.md (about 161 changed lines across five files). No `estimatedLoc` because this is a story.
- Caller search found `runJudge` at we:scripts/lib/model-probation.mjs:440-443 as the production sweep/store adapter. Its dry-run, persisted-row and CLI fixtures already live in the trials suite. Previously judged historical rows remain historical; pending launches without valid timestamps stay pending. No registry rewrite, new setting, or change to the generic best-effort store lock default is required.

## Design

1. Exercise `appendScorecardUnlessJudged` with a valid probation row and explicit temporary store path, using real file IO and a pre-existing fresh lock file. Seed a nonempty store and capture its exact bytes. Spy only on `Date.now` so the acquisition start is the real lock mtime and the next age/elapsed checks advance 5,001 ms: above the 5-second wait budget, below the 15-second stale threshold. Supply `scoredAt` on the row. Assert the lock-acquisition error, identical store bytes, and an untouched lock. Restore clock and remove the temporary tree in `finally`. Do not inject `io.write` or mock the lock implementation.
2. In `judgePendingTrials`, require both `review:accepted` and a valid `reviewLabelAt` strictly later than valid `launch.scoredAt` before a merged PR is counted as reviewed. Use the existing pending branch for stale, equal, absent, or invalid evidence; append nothing. Keep pure `trialOutcomeFromPr` merge/close classification unchanged. Update the sweep comment to distinguish outcome classification from review eligibility and name the refusal regression. The existing operator fallback is a fresh review event followed by a later sweep; missing launch time requires recovering valid launch evidence, never guessing it.
3. Define complete scope as an array with an authoritative nonnegative integer `changedFiles` equal to its length; when the count is absent, retain the existing below-100 fallback. An explicit count mismatch or invalid count remains incomplete. Thus exact 100/100 (and a larger fully supplied matching list) is complete, while 100/unknown and truncated lists remain unknown. Retain the real critical-work classifier: completeness does not make sensitive files safe. No pagination/network expansion is part of this fix.
4. Append a review-lens rule to we:docs/agent/testing.md: every doc-comment claim that an operation refuses or fails closed must name a test reaching that refusal branch and proving the forbidden side effect is absent. Add the named lock test reference to the lock-refusal comment in we:scripts/conveyor/run-scorecard-store.mjs. This is a review rule, not a new repository-wide scanner.

## MVP

Must ship the real lock-refusal regression and mutation evidence, fresh-acceptance gating with caller fixture updates, complete-count boundary correction with fail-closed neighbors, and the named-test review rule. Keep existing unreviewed-merge pending behavior, append deduplication, dry-run behavior, and generic lock defaults. All five scope files are the single delivery slice.

Could later automate refusal-comment coverage discovery or fetch complete oversized PR lists; neither is needed to prove this slice.

## Acceptance

- [A1] Executable — proposed test `#4685 held append lock throws without changing store or lock` in we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs must exercise real exclusive-create contention. It must fail when `requireLock: true` is removed from `appendScorecardUnlessJudged`, and pass with the guard restored. This is mutation-red evidence for an already-correct production guarantee, not a claim that the current guard is broken.
- [A2] Executable — proposed table test `#4685 merged acceptance requires fresh evidence` in we:scripts/lib/__tests__/model-probation-trials.test.mjs must leave stale/equal/missing/invalid label or launch timestamps pending with zero appends, then accept a strictly newer event exactly once. Include string and object labels and a persisted launch through `runJudge`; assert dry-run leaves store bytes unchanged and unjudged historical launches do not gain credit from missing timestamps. Stale merged acceptance fails on the current implementation and passes after the fix; existing success callers must supply fresh timestamps explicitly.
- [A3] Executable — proposed table test `#4685 complete count preserves scope without hiding critical misses` in we:scripts/lib/__tests__/model-probation-trials.test.mjs must retain all 100 files for 100/100 and yield `criticalMiss: false` for a reworked ordinary-docs fixture using the real classifier. Test complete matching lists above 100, below-100 legacy absence, and unknown/mismatched/invalid counts. Incomplete docs, config and data lists must still omit `filesTouched` and fail closed; a complete sensitive scope must still yield a critical miss. The 100/100 row fails before and passes after the fix; the negative neighbors guard the loosened bound.
- [A4] Executable — add the exact rule sentence `Every refusal doc comment must name a negative test.` to we:docs/agent/testing.md and cite the A1 test in the append comment. The shell check `p=we:docs/agent/testing.md; rg -F 'Every refusal doc comment must name a negative test.' "${p#we:}"` and `p=we:scripts/conveyor/run-scorecard-store.mjs; rg -F '#4685 held append lock throws without changing store or lock' "${p#we:}"` must both exit zero after build and fail before. Review verifies the cited test actually reaches the refusal, as A1 requires.

## Test plan

Use the existing suites, not a parallel test harness. Keep temporary stores under the task's `$TMPDIR`. The lock test must leave all shared/default stores untouched and restore clock state even on assertion failure. The sweep tests use injected PR reads and real classification; no live GitHub calls. Extend the existing persisted-store and CLI fixture coverage with fresh merged acceptance rather than loosening its graduation assertions. Retain existing lookup-failure, incomplete-scope, unreviewed-merge, concurrent append and skipped-append cases.

Run the two affected suites through the host queue. Repository prefixes are stripped only at execution: `a=we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs; b=we:scripts/lib/__tests__/model-probation-trials.test.mjs; q=we:scripts/readiness/heavy-admission.mjs; node "${q#we:}" run -- npx vitest run "${a#we:}" "${b#we:}"`. If busy, use the queue's own single bounded wait, then stop and report. Do not run the full suite.

## Proof plan

During build, capture A2/A3 failures with the new tests against the old implementation, then passing output after the narrow fixes. For A1 temporarily remove only the probation helper's `requireLock: true`, run its named test through the same queue with a test-name filter, record failure, restore the guard, and record success. Never retain the mutation. Run both affected suites together after restoration, and record the A4 text-check results. The runner owns preparation stamping and checks; this preparation does not assert runtime test results. Build validation additionally runs queued `npm run check:standards`.

## Follow-ups

No dependency changes proposed. A repository-wide refusal-comment scanner and fetching oversized incomplete PR file lists are separate possible follow-ups, not hidden MVP work. Keep unknown file scope fail-closed until complete evidence is available. Do not rejudge already persisted trials or change graduation policy in this story.
