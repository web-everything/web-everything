---
bornAs: xp1xkis
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs", "we:scripts/operations/open-pr.mjs", "we:scripts/operations/open-pr-io.mjs", "we:scripts/operations/__tests__/open-pr-io.test.mjs", "we:scripts/operations/__tests__/open-pr.test.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/conveyor/infra-blocked.mjs", "we:scripts/conveyor/__tests__/infra-blocked.test.mjs", "we:scripts/lib/conveyor-sync-timeout-guard.mjs", "we:scripts/lib/__tests__/conveyor-sync-timeout-guard.test.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:skills-src/pr/SKILL.md", "we:skills-src/pr/__tests__/pr-diff-checklist.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "17469e55bc0bd7c2cb28364b533360d130d724ed"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2899's independent review

Preserve the prevention debt from chalbert/web-everything#2899's independent review: require a durable resume record before reporting an infra-pending delivery, prevent unbounded synchronous daemon children, exercise resume failures behaviorally, and compare PR descriptions with the actual diff before creation. Duplicate undefined-function recommendations are one fetch-failure regression obligation, not three separate lint projects.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2899@2458ab6070db459dec91ef28a2c64f3cc78de726

## Progress

- Original premise/scope: seven mechanically copied review notes cited wrapper line 566, daemon line 389, and infra retry lines 641–644; scope named only those three modules and their tests. Notes 4, 5, and 7 repeated an undefined-function concern; note 6 withheld its source path.
- Corrected premise: the wrapper's live catch is at `we:scripts/operations/deliver-item-wrapper.mjs:585`, and its classifier at `we:scripts/operations/deliver-item-wrapper.mjs:2608` accepts the reason token from prose without checking persistence. `we:scripts/pr-land.mjs:758` already computes and emits `recorded`, but `we:scripts/operations/open-pr.mjs:339` drops it and `we:scripts/operations/open-pr-io.mjs:197` throws away the structured result. The prevention requires transport changes as well as a wrapper assertion; it is not already delivered.
- The cited daemon fix moved and partly landed: `we:skills-src/conveyor/build-dispatch-daemon.mjs:1358` has injectable execution and a timeout; `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:938` tests it, including a real child-tree probe at line 1000. A future-call guard is still owed: `we:skills-src/conveyor/build-dispatch-daemon.mjs:1244` invokes injected synchronous execution without a timeout. Do not repeat the already-present retry timeout fix.
- The live resume implementation is private at `we:scripts/conveyor/infra-blocked.mjs:701`; fetch handling at line 719 calls the existing `classifyPrOpenFailure`, rather than an undefined helper. SHA pinning exists at line 726. `we:scripts/conveyor/__tests__/infra-blocked.test.mjs:292` tests the pure SHA decision and line 470 checks source text, neither of which executes the fetch catch. The remaining obligation is behavioral branch coverage, using the original review's explicit unit-test alternative to repository-wide no-undef linting.
- The identifiable PR-authoring home is `we:skills-src/pr/SKILL.md:121`, which requires a body but does not explicitly compare each claimed file change with the diff. Add the owed checklist there; no speculative recovery of the withheld citation is needed.
- Corrected scope adds the two result-transport modules and their existing shared test, a planned timeout guard and its tests, the standards entry point and its matching test, and the PR checklist with a planned contract test. Size changes **3 → 5**: the two loss points above and the missing timeout at `we:skills-src/conveyor/build-dispatch-daemon.mjs:1244` make this a multi-boundary prevention change, rather than three local assertions. No dependency change is proposed. Preparation is source inspection only; implementation probes below remain to run.

- Validation repair: the previous scope relied on the shared sink coverage in `we:scripts/operations/__tests__/open-pr.test.mjs:479` for `we:scripts/operations/open-pr-io.mjs:179`. Add planned `we:scripts/operations/__tests__/open-pr-io.test.mjs` as the matching test scope for the sink transport regression; the existing shared tests remain. This corrects the missing test-file mapping without changing the goal or size.

## Design

1. Preserve `recorded` as a boolean on the classified blocked-on-infra result in `we:scripts/operations/open-pr.mjs`. For this specific result, make `we:scripts/operations/open-pr-io.mjs` return the structured classification through the existing effect result instead of encoding it only in an exception sentence. Keep all other unrun errors and refusal classifications unchanged. In `we:scripts/operations/deliver-item-wrapper.mjs`, handle that result before the generic non-opened branch: only `recorded === true` may settle open-pending. False, missing, or malformed persistence evidence must throw into wrapper-threw; legacy text-only exceptions cannot authorize release as resumable. Update the classifier accordingly, removing its prose-token-only authorization.
2. Export `resumeOpen` from `we:scripts/conveyor/infra-blocked.mjs` and inject `exec = execFileSync`; route fetch, rev-parse, and PR submission through it. Preserve deadlines, reason buckets, SHA pinning, and CLI defaults. Use temporary test bodies with cleanup, without real GitHub requests. A fetch-outage behavioral regression supplies the undefined-function guard explicitly permitted by the original review.
3. Add a deterministic source guard in planned `we:scripts/lib/conveyor-sync-timeout-guard.mjs`, wired into `we:scripts/check-standards.mjs`. Its initial production target is `we:skills-src/conveyor/build-dispatch-daemon.mjs`, the daemon named by this review. Detect direct synchronous child-process calls and aliases/default-injected executors, including the existing `exec` seam. Resolve local options objects such as the reader's `opts`; require an explicit timeout or delegation to `we:scripts/lib/bounded-child.mjs`. Use syntax-aware inspection, not a regex that comments or multiline calls can defeat. Emit file/line diagnostics for missing or unresolvable bounds. Bound uncovered synchronous calls in the named daemon using operation-appropriate existing deadlines; do not apply a short read timeout to dispatch/build work. This gate does not claim interprocedural coverage of every imported helper or asynchronous child lifetime.
4. Add a pre-create checklist to `we:skills-src/pr/SKILL.md`: compare the final description's file/behavior claims with the exact base-to-head diff, inspect the relevant hunks, and correct unsupported claims before submission. This is the requested human/agent checklist, not a new semantic-diff approval gate. A small contract test keeps the instruction adjacent to body preparation and before open/handoff.

## MVP

- Carry the persistence bit across classification, sink, operation envelope, and wrapper; retain the existing success/refusal semantics outside the single infra case.
- Add the injectable resume seam and behavioral branch matrix in the existing infra test file, replacing only source assertions superseded by those behaviors.
- Ship the daemon timeout guard, standards wiring, and bounded calls together. Retain the existing retry timeout and real subprocess regression.
- Add the PR-body/diff checklist and its contract test. No global lint rollout, retry policy change, or new blocker is necessary.

## Test plan

- `we:scripts/operations/__tests__/open-pr.test.mjs`: feed real-shaped PR-land reports with `recorded: true`, false, absent, and invalid values through classification. Verify preservation of the persistence bit and unchanged non-infra classifications.
- Planned `we:scripts/operations/__tests__/open-pr-io.test.mjs`: exercise the injected runner and submit sink with `recorded: true`, false, absent, and invalid values. Verify the structured infra result survives the sink unchanged and non-infra failures/refusals retain their existing behavior; retain the existing shared sink regressions in `we:scripts/operations/__tests__/open-pr.test.mjs`.
- `we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs`: drive delivery with the operation-envelope result, not just the classifier. True yields open-pending; false/absent/invalid and legacy prose-only errors yield wrapper-threw, never the resume promise. Assert terminal outcome, hold, and cleanup behavior so classifier-only success cannot mask wiring errors.
- `we:scripts/conveyor/__tests__/infra-blocked.test.mjs`: execute resumeOpen with injected fetch outage and SIGKILL (no later calls), moved SHA (no submit), known refused reason, unknown/malformed failure, and PR-present nonzero exit. Verify the recorded SHA and deadlines passed to execution; include missing-ref and cross-repo early exits. A fetch outage must return an infra failure, never throw ReferenceError or become bad-ref.
- `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`: retain existing retry bound tests and verify bounds on any newly corrected execution paths, including timeout failure behavior.
- Planned `we:scripts/lib/__tests__/conveyor-sync-timeout-guard.test.mjs`: reject direct/aliased/injected unbounded calls, multiline syntax, misleading timeout comments, missing options, and unresolved options; accept inline/local timeout options and bounded-helper delegation. Scan the actual daemon too. `we:scripts/__tests__/check-standards.test.mjs` must prove the rule is wired into the gate, with an unbounded fixture producing a diagnostic.
- Planned `we:skills-src/pr/__tests__/pr-diff-checklist.test.mjs`: check the diff comparison instruction remains between body preparation and PR submission. Human review must additionally exercise a description claiming a file absent from a sample diff; the text-presence test alone does not prove adherence.

## Proof plan

Run each named test file only through the host queue: invoke `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <test-file>` with the `we:` locus removed from executable arguments in the WE checkout. Run the standards gate through the same queue with `npm run check:standards`. Capture commands, exit codes, and assertions for the eventual delivery evidence; the preparation runner owns preparation checks and stamping.

Demonstrate red/green with isolated fixtures: dropping `recorded` must fail the transport/wrapper regression; changing the fetch catch to an undefined helper must fail the resume regression; removing a daemon timeout must fail the static guard and standards integration test. Restore mutations before the final run. Use fakes/temp repositories for PR operations; do not create a real PR or alter the live infra store as a test. Review the checklist against a sample base/head diff containing one deliberately false file claim and record the correction.

## Done when

The queued tests and standards gate pass; the three targeted regressions fail under their corresponding mutations; recorded:false cannot produce an open-pending promise; resume fetch failures execute safely; and the pre-create description/diff checklist is present with its review evidence.

## Follow-ups

Broader daemon discovery, interprocedural timeout analysis, repository-wide undefined-symbol linting, and automated semantic validation of PR descriptions remain outside this prevention item. The targeted guard must state its coverage honestly. Do not reopen the already-covered retry timeout fix or silently change retry/backoff policy. Record any newly discovered independent defect separately during implementation; no follow-up is a prerequisite for this MVP.
