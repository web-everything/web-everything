---
bornAs: xgyqyct
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/conveyor/infra-blocked.mjs", "we:scripts/conveyor/__tests__/infra-blocked.test.mjs", "we:scripts/conveyor/soak/breaks/build-daemon-retry-blocks-tick-on-slow-ci-wait.mjs", "we:scripts/conveyor/soak/breaks/build-daemon-retry-blocks-tick-on-slow-ci-wait.soak.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/build-daemon-retry-blocks-tick-on-slow-ci-wait.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "32fbad6f48ce3ccdfd1df70dd42ba1a5da64cf96"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2992's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:2095` — Bound repeated retries as well as each individual tick: two consecutive timed-out retries must never overlap live landing processes for the same item. Use the originally permitted per-item in-flight lease and prove it with a slow-child soak.
2. `we:skills-src/conveyor/build-dispatch-daemon.mjs:2116` — Match `e.code === 'ETIMEDOUT'` only; foreign SIGTERM must remain an ordinary error.
3. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:1157` — Require a positive integer default as well as the existing interval upper bound.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2992@67b93ba67a50d511437746eab2dda7e9e33da6a0

## Acceptance

All named tests below are planned additions or strengthened assertions, not claims that they already pass. Commands are run from WE; `we:` identifies repository-relative test paths. Use the host heavy queue for every invocation.

- [A1] Executable — `consecutive timed-out retries never overlap a landing child` in the planned `we:scripts/conveyor/soak/breaks/__tests__/build-daemon-retry-blocks-tick-on-slow-ci-wait.test.mjs`: invoke through `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <test-path>`, removing the repository prefixes for shell execution. Two daemon timeout calls against the same persisted item, followed by another retry, must observe maximum live landing children <= 1. The direct assertion must fail on the old implementation, not be hidden behind the soak harness's expected-failure mode.
- [A2] Executable — `foreign SIGTERM is not a timeout` and `ETIMEDOUT is a timeout with or without a signal` in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`, run with the same queued command and that test path. Keep the error payload and nonthrowing behavior; only ETIMEDOUT sets `timedOut`. The foreign-SIGTERM assertion fails before the fix.
- [A3] Executable — strengthen `the default bound leaves real headroom inside the daemon tick interval` in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`, run through the same queued command. Assert integer, > 0, and < interval. Prove the added guard by temporarily setting the default to zero and to a fraction: each mutation must fail, then restore 60_000 and pass. No default change is intended.
- [A4] Executable — `held or unreadable reservation refuses resume without spending attempts` and `completed owner releases only its own reservation` in `we:scripts/conveyor/__tests__/infra-blocked.test.mjs`, run through the same queued command. Missing ownership evidence, corrupt/oversized metadata, and acquisition IO failure must launch no landing process and surface an operator-visible reason. Completion permits another retry; parent termination does not release a reservation while its child may live. These cases lack the required reservation behavior before the build.
- [A5] Executable — `timeout fixtures preserve the caller contract` in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` and the existing soak test at `we:scripts/conveyor/soak/breaks/build-daemon-retry-blocks-tick-on-slow-ci-wait.soak.test.mjs`, run through the same queued command. Update both timeout fakes to emit ETIMEDOUT; assert the soak reports `timedOut: true`, and retain successful retry results, explicit timeout override, and daemon tick continuation. Apply the strict classifier alone first to show the old fixture fails, then update fixtures and pass.

## Design

Keep the 60-second daemon bound and the existing retry result shape. Change only timeout classification and its documentation in `we:skills-src/conveyor/build-dispatch-daemon.mjs`; remove the unsupported claim that an orphan is harmless. Backoff is not mutual exclusion: `we:scripts/conveyor/infra-blocked.mjs:889` invokes resume before persisting its outcome, so a killed parent leaves an eligible entry behind.

Implement the card's already-offered per-item reservation at the resume boundary in `we:scripts/conveyor/infra-blocked.mjs`. Key it by the resolved primary store and normalized item number, using a safe encoded filename in a sibling reservation directory. Acquire atomically before any landing spawn; keep reservation state separate from the existing store schema so old entries need no migration. Record a unique owner token and diagnostic identity. Do not hold the short global store lock across slow IO: its current stale-age takeover and best-effort fallback are unsuitable for this guarantee (`we:scripts/conveyor/infra-blocked.mjs:559`).

Release only after the synchronous landing invocation has demonstrably completed, and only for the acquiring token. No SIGTERM cleanup may drop the reservation. On parent death, ambiguous spawn failure, or uncertain child completion, retain it. No age-based or parent-PID-only reclamation: a dead parent does not prove a dead grandchild. A held, incomplete, unreadable, or oversized reservation fails closed for that item, reports the reservation path and operator-inspection reason in retry output, and consumes neither failure nor refusal budget. Other items continue. Bound metadata reads to 16 KiB. The operator fallback is to verify that the recorded landing work has stopped before clearing that exact reservation; the diagnostic must explain this. Automatic orphan recovery is outside this MVP.

Expose injectable resume/ownership IO for hermetic tests without changing production CLI defaults. The daemon caller at `we:skills-src/conveyor/build-dispatch-daemon.mjs:1526` must still receive a bounded, nonthrowing result. Update the timeout fake in `we:scripts/conveyor/soak/breaks/build-daemon-retry-blocks-tick-on-slow-ci-wait.mjs` as well as the unit helper; SIGTERM alone is no longer valid timeout evidence.

## MVP

Must: strict error-code classification; positive-integer default regression; per-item fail-closed reservation across parent timeout; operator-visible retained-reservation diagnosis; two-attempt real-process soak using a fake slow landing executable; caller/fixture compatibility. Preserve the existing retry budgets, successful result parsing, primary-store routing, and 60_000 default.

Could: automatic recovery of abandoned reservations using independently verified descendant identity. Do not add it to this slice or infer safe release from elapsed time. No general process supervisor, global retry serialization, or change to landing policy is required.

## Test plan

Extend the existing daemon unit tests for A2, A3, and A5. Correct the fake error's code explicitly rather than weakening the timeout assertion. Extend `we:scripts/conveyor/__tests__/infra-blocked.test.mjs` for A4 with temporary stores, injected resume calls, token replacement, old-format entries without reservations, two different items, IO failures, and oversized metadata.

Extend the existing soak implementation and add `we:scripts/conveyor/soak/breaks/__tests__/build-daemon-retry-blocks-tick-on-slow-ci-wait.test.mjs` for A1; retain the existing soak wrapper for A5. Launch the production reservation/resume path with a fake slow child, isolated store, and readiness handshake before triggering each timeout. Keep the first child alive across the second attempt; measure live PIDs rather than counting only spawn calls or assuming backoff prevents overlap. Also timeout the second retry parent after its refusal using a fixture delay, proving two bounded parent terminations cannot remove the first reservation. Clean up every child in finally and use task TMPDIR. Never contact GitHub or invoke real landing actions. Add an unconditional assertion alongside the harness so missing fix detection cannot turn the regression green via expected-failure semantics.

Run only the four scoped test files through the host heavy queue. If busy, use one queue-managed wait and stop/report if unavailable; do not poll. The runner owns preparation checks and stamping.

## Proof plan

During implementation, capture failing A1/A2/A4 tests against pre-fix production behavior, then passing output after the change. For A3 record the zero/fraction mutation failures and restored-default pass. For A5 record the classifier-only fixture failure and corrected-fixture pass. Include the child readiness events, both parent timeout results, maximum live-child count, retained reservation diagnostic, and cleanup verification. A single timed-out process tree proves bounded return only; it is not evidence of nonoverlap. Preparation here establishes source evidence, not a claim that the future implementation has been executed.

## Follow-ups

Automatic retained-reservation recovery is a separately designed extension: it must prove the entire landing invocation has ended, including after parent death, before reclaiming. Until then, the explicit operator inspection fallback is required. No dependency changes are proposed.

## Progress

- Original premise/scope: two daemon files, size 3, stale references at daemon lines 537/563 and test line 670; the card offered a consecutive-retry soak or per-item lease and assumed orphan retries were harmless.
- Corrected evidence: `we:skills-src/conveyor/build-dispatch-daemon.mjs:2101` explicitly acknowledges surviving grandchildren; line 2116 still accepts any SIGTERM. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:1157` checks only the upper bound, and its timeout helper at line 1188 supplies only SIGTERM. The real-tree case at line 1221 measures one timeout, not overlapping retries.
- Scope correction: `we:scripts/conveyor/infra-blocked.mjs:771` waits on landing for up to 20 minutes, whereas the daemon default is 60 seconds; `we:scripts/conveyor/infra-blocked.mjs:889` resumes unlocked and only records the outcome afterward. Its short store lock at line 559 cannot be repurposed as a lifetime lease. Include this producer and its existing matching test. Include the existing soak pair because `we:scripts/conveyor/soak/breaks/build-daemon-retry-blocks-tick-on-slow-ci-wait.mjs:54` calls the classifier with a SIGTERM-only fake and currently judges elapsed time rather than nonoverlap.
- Size 3 → 5: estimated touch set is daemon source ~15 changed lines, daemon tests ~55, infra source ~90, infra tests ~100, soak implementation ~90, and soak wrapper ~20 (about 370 lines across six files). The cross-process reservation and deterministic cleanup proof justify the increase. This remains a story; no estimatedLoc field is added.
- Source inspection confirms outstanding work; no delivering commit is claimed. No runtime files were changed or tests run during this card-only preparation. Preparation stamps remain runner-owned.

- Prepare-validation repair: the prior six-file scope listed only the colocated soak wrapper, `we:scripts/conveyor/soak/breaks/build-daemon-retry-blocks-tick-on-slow-ci-wait.soak.test.mjs`, whose lines 1–4 import the break and call the shared harness. The matching test directory does not yet exist. Add the planned `we:scripts/conveyor/soak/breaks/__tests__/build-daemon-retry-blocks-tick-on-slow-ci-wait.test.mjs` to scope and place A1's unconditional regression there, preserving the existing wrapper for A5. This corrects the missing test scope without changing the prevention goal or the completed design. The prior ~20-line wrapper estimate is now ~5 wrapper lines plus ~30 new direct-test lines: approximately 385 changed lines across seven files; size remains 5. No preparation stamp is added.
