---
bornAs: xgyqyct
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/conveyor/infra-blocked.mjs", "we:scripts/conveyor/__tests__/infra-blocked.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "7ded8d570e39ef6bc3c8f2a731db99f0334ee284"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2992's independent review

Filed mechanically on approval of chalbert/web-everything#2992. Complete the owed timeout-classification, timeout-default, and repeated-retry concurrency prevention guards.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2992@67b93ba67a50d511437746eab2dda7e9e33da6a0

## Progress

Preparation research found the original three debts still present; this is not already delivered. No runtime behavior was changed or tested during preparation.

- Old premise/scope: the daemon and its test alone could cover a two-timeout soak (or per-item lease), strict ETIMEDOUT classification, and positive-integer default; citations were daemon lines 537/563 and test line 670.
- Corrected premise: the wrapper is now at `we:skills-src/conveyor/build-dispatch-daemon.mjs:2105`, with the broad SIGTERM-or-ETIMEDOUT predicate at line 2116. Its documentation at line 2098 calls surviving grandchildren harmless, but does not establish non-overlap. The existing default assertion at `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:1158` checks only the interval upper bound. The fake timeout at line 1188 supplies only SIGTERM; it must gain the real timeout code. The real process-tree case at line 1221 covers one timeout and elapsed time, not two retries or live descendant counts.
- Corrected scope adds `we:scripts/conveyor/infra-blocked.mjs` and `we:scripts/conveyor/__tests__/infra-blocked.test.mjs`: the actual landing invocation is at `we:scripts/conveyor/infra-blocked.mjs:771`, and retry calls it before recording an outcome at line 891. The store lock documented at line 559 deliberately does not cover slow IO. Killing the direct retry child therefore does not establish that the landing descendant exited or that the next pass cannot repeat it.
- Callers: `we:skills-src/conveyor/build-dispatch-daemon.mjs:1526` consumes retry results best-effort; `we:skills-src/conveyor/runner.mjs:377` also invokes the retry CLI. Put exclusion at the shared retry boundary, not solely in the daemon. Existing records need no schema migration.
- Size changes **3 → 5**: estimated touch set is daemon ~15 changed lines, daemon tests ~100, infra retry lease/lifecycle/reporting ~110, infra tests ~110 (about 335 changed lines across four files). The additional cross-process lifecycle work follows the invocation and post-return mutation evidence above; this remains a story, with no estimatedLoc field.

## Design

Use the original card's per-item in-flight lease option and also add the two-timeout soak. In `we:scripts/conveyor/infra-blocked.mjs`, acquire an exclusive-create lease keyed by canonical store location and normalized item number before resume work. Keep it separate from the short-lived store mutation lock. All retry callers use this boundary. Re-read eligibility after acquisition so a stale snapshot cannot repeat a completed attempt.

Hold the lease until the synchronous landing child has returned and the outcome has been persisted. Release only the lease owned by that attempt, using an ownership token. A live or unreadable lease means no landing spawn, no attempt/refusal-budget consumption, and an operator-visible waiting reason in the retry result and stderr. Never use the existing store lock's best-effort unlocked fallback for this exclusion.

A killed retry parent cannot prove its grandchild is dead. Consequently do not expire or steal this lease based on age or a dead parent PID. Leave an interrupted lease closed, with diagnostic ownership/item information; the operator must verify the associated process tree has stopped before removing that item's lease and retrying. Document this recovery alongside the lease code. This conservative recovery avoids introducing a new process supervisor or treating orphanhood as proof of safety.

In `we:skills-src/conveyor/build-dispatch-daemon.mjs`, classify timeout only by `e.code === 'ETIMEDOUT'`, preserving the bounded error envelope for other failures. Correct the wrapper documentation accordingly. Keep the 60,000 ms default, SIGTERM kill signal, explicit override, interval, and best-effort caller behavior unchanged. Pin the default as an integer greater than zero and less than DEFAULT_INTERVAL_MS.

## MVP

1. Add the shared per-item lease boundary and explicit waiting diagnostics in `we:scripts/conveyor/infra-blocked.mjs`, retaining current resume SHA checks, result classification, and backoff rules.
2. Narrow the daemon timeout predicate; update its timeout fixture to include ETIMEDOUT and add foreign-SIGTERM coverage in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`.
3. Extend the default-bound assertion and add real subprocess concurrency coverage using a fake slow landing executable, isolated store, and injected IO. Keep the production lease path in the exercised call chain.

## Acceptance

The following commands run from the WE repository root. Each command strips the repository prefix from its path variables and uses the host heavy queue. Named tests are required additions, not claims that they already exist.

- [A1] Executable — `queue=we:scripts/readiness/heavy-admission.mjs; testFile=we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs; node "${queue#we:}" run -- npx vitest run "${testFile#we:}" -t '4535 timeout classification'`: ETIMEDOUT produces timedOut; foreign SIGTERM with absent or different code produces error without timedOut. Fails against the current broad predicate.
- [A2] Executable — `queue=we:scripts/readiness/heavy-admission.mjs; testFile=we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs; node "${queue#we:}" run -- npx vitest run "${testFile#we:}" -t '4535 default bound'`: asserts integer, positive, below interval, default forwarding, and explicit override forwarding. Demonstrate red with the default temporarily mutated to zero, negative, and fractional, then green with the unchanged production default; the current default is already valid, so this is a mutation-based prevention proof.
- [A3] Executable — `queue=we:scripts/readiness/heavy-admission.mjs; testFile=we:scripts/conveyor/__tests__/infra-blocked.test.mjs; node "${queue#we:}" run -- npx vitest run "${testFile#we:}" -t '4535 repeated timeout'`: two consecutive bounded retry invocations against the same item and slow landing fixture never exceed one live landing process, including while the first descendant survives its parent. Both calls return within their bounds; the second may return an explicit lease hold rather than time out. The current unguarded path fails the peak-count assertion.
- [A4] Executable — `queue=we:scripts/readiness/heavy-admission.mjs; testFile=we:scripts/conveyor/__tests__/infra-blocked.test.mjs; node "${queue#we:}" run -- npx vitest run "${testFile#we:}" -t '4535 lease lifecycle'`: normal completion releases only its own lease after settlement; separate items remain independent; both CLI caller routes share exclusion; live, unreadable, incomplete, and interrupted leases prevent spawning and preserve budgets, with waiting diagnostics. Age and dead-parent evidence alone never authorize another spawn. Tests fail before lease implementation.

## Test plan

Implement A1–A2 in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` and A3–A4 in `we:scripts/conveyor/__tests__/infra-blocked.test.mjs`. Update the existing synthetic timeout shape, retaining its elapsed-time and successful-completion assertions. Use actual child PIDs/start-exit records for the soak, a startup handshake before timing the parent kill, and a test deadline; never infer absence of overlap solely from elapsed time. Fixture files belong under the task TMPDIR. Finally terminate and reap every fixture descendant before deleting its files, even after assertion failure.

Cover failure before spawn, successful landing, refused landing, infra failure, outcome-persistence failure, and acquisition/read failures. A persistence failure retains the lease and surfaces recovery details. Pin a legacy store entry without lease metadata and verify its first attempt still works. Exercise the lease through the actual retry adapter, not only a standalone mocked lock helper. No GitHub or network calls in fixtures.

## Proof plan

During build, first run the added regression cases against the unchanged implementation and record the expected predicate/concurrency failures. Use the explicit mutations in A2 to prove the new assertion rejects invalid defaults. Then run both affected test files through the host heavy-admission queue, followed by the runner-owned checks. Record commands, exit results, peak live landing count, and the retained-lease diagnostic. A passing pre-existing one-child timing test is not concurrency proof. If admission is busy, use its supported wait option once and report rather than polling.

## Follow-ups

No new prerequisite or blockedBy change is proposed. Automatic recovery of leases after uncertain process death and general process-tree supervision are outside this prevention slice; retain the explicit operator recovery path until separately designed. Do not expand this item into changes to landing policy, daemon interval/default tuning, or the infra backoff budget.
