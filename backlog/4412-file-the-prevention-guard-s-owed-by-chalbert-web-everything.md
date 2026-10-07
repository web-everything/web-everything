---
bornAs: x52sjqd
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/lane-verify.mjs", "we:scripts/lib/__tests__/lane-verify*.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/__tests__/lane-verify.test.mjs", "we:scripts/verify-lane.mjs", "we:docs/agent/testing.md"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-07"
preparedAgainstSha: "52e617c26f2fc902a3a4babc0f566a5c3862c20a"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2878's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/lane-verify.mjs` — A test coverage rule that requires default arguments of exported functions to be exercised by at least one test without explicit overrides.
2. `we:scripts/__tests__/verify-lane.test.mjs:350-445` — A testing guideline requiring polling tools to integration-test the target state transitioning *while* the loop is running, not just at start and timeout boundaries.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2878@cf59b9d109a15c4329a60f9970a9086ddd577c9e

## Progress

Preparation checked the current checkout; no implementation or test execution is claimed.

- **Prepare-validation repair:** add the runner-required narrow test-scope pattern `we:scripts/lib/__tests__/lane-verify*.test.mjs`. No matching test currently exists there; the existing unit suite remains `we:scripts/__tests__/lane-verify.test.mjs`, whose injected-timing transition at lines 891-907 exercises `we:scripts/lib/lane-verify.mjs:409-461`. This scope reservation satisfies the requested test-scope boundary without moving the existing suite or changing the completed implementation plan.

- **Old premise/scope:** the two review debts named the verification core and CLI test, with a unit-test scope entry at nonexistent `we:scripts/lib/__tests__/lane-verify.test.mjs`. The historical CLI citation at line 162 now points into the carried-forward-marker integration coverage, not the wait suite.
- **Corrected premise/scope:** the unit suite is `we:scripts/__tests__/lane-verify.test.mjs`. Default coverage is partially present: the no-argument resolver assertion is at lines 328-331; an immediate terminal wait omits timing overrides at line 1112; the long-budget case omits the poll interval at lines 1138-1143. None of those proves the default sleep executes across a running-to-terminal transition. The synthetic transition at lines 891-907 overrides clock, sleep and interval. Retain those tests and fill the behavioral gap, rather than treating every default as untested.
- **Source evidence:** `we:scripts/lib/lane-verify.mjs:409-420` declares the wait defaults, and `we:scripts/lib/lane-verify.mjs:426-461` rereads state and awaits sleep. `we:scripts/verify-lane.mjs:195-208` supplies live marker/HEAD readers and leaves timing defaults in place. The CLI suite at `we:scripts/__tests__/verify-lane.test.mjs:365-381` tests already-green and never-settles boundaries; it lacks a marker transition during that CLI wait. The existing testing guide, `we:docs/agent/testing.md`, does not state either owed rule.
- Add the testing guide as the home of both rules and the CLI source as the integration target. Source/test pairs are `we:scripts/lib/lane-verify.mjs` → `we:scripts/__tests__/lane-verify.test.mjs` and `we:scripts/verify-lane.mjs` → `we:scripts/__tests__/verify-lane.test.mjs`. The guide is documentation, not an additional runtime source needing a unit-test file.
- Size remains **3**: two bounded test additions plus testing guidance, using the existing temporary-repository fixture at `we:scripts/__tests__/verify-lane.test.mjs:34-56`; no new runtime feature or repository-wide static coverage analyzer is required.

## Design

Codify both owed review rules in `we:docs/agent/testing.md`: exported functions with default arguments need a behavioral test that omits the relevant optional overrides; polling tools need an integration case where the target changes after polling begins. Required inputs still must be supplied. An immediate return does not exercise a default timer, and passing the default value explicitly does not test omission. Existing coverage counts; do not duplicate it merely to add a new test name.

Apply the rules to the wait path. In `we:scripts/__tests__/lane-verify.test.mjs`, add a running-to-green case that omits `now`, `sleep`, and `pollIntervalMs`. Vitest fake timers may control the global clock and timer scheduler while leaving the function's own default expressions active. Assert the first read is running, no second poll occurs before the default 2,000 ms interval, and the next poll reads green and settles. Restore timers in a finally block.

In `we:scripts/__tests__/verify-lane.test.mjs`, run the actual CLI asynchronously in its existing throwaway repository, using real filesystem marker reads and real timers. Synchronize the writer with evidence that the wait has entered its first sleep, not a guessed startup delay. A child-only Node preload can wrap the global timer, delegate to the real timer, and send an IPC notification for the first 2,000 ms polling delay. Only then atomically replace the running marker with a same-HEAD terminal marker. Keep this observation fixture local to the test; do not add a production test flag. Use a generous bounded wait and kill/reap the child in finally before fixture cleanup.

## MVP

1. Add the two guidelines, with links to the executable examples, in `we:docs/agent/testing.md`.
2. Add the omitted-timing-default regression in `we:scripts/__tests__/lane-verify.test.mjs`; preserve existing strict-default and injected-clock cases.
3. Add parameterized running-to-green and running-to-red CLI cases in `we:scripts/__tests__/verify-lane.test.mjs`. Assert same HEAD, more than one poll, `settled: true`, terminal status, and exit 0 for green / 2 for strict red. Leave verification opt-out and break-glass environment variables unset in these child fixtures.
4. Keep production semantics unchanged; the scoped sources identify what the new tests exercise. Refresh the stale fake-clock-only suite comment in `we:scripts/__tests__/lane-verify.test.mjs:873-876` when adding the default-timer case.

## Test plan

- Unit: exercise the real default expressions under controlled global timers; pin the existing 2,000 ms cadence and multiple reads. Assert default strictness for red without passing `requireVerified` in the CLI cases.
- Integration: require the first-sleep notification before writing a terminal marker; assert multiple polls so a too-early fixture update cannot produce a false pass. Use atomic rename to prevent a torn JSON read from becoming a spurious corrupt verdict. Bound handshake and child completion separately; on timeout report captured stdout/stderr and clean up the child.
- Retain already-green, timeout, invalid-ceiling, clamp, and HEAD-move coverage. The new cases supplement those boundaries.
- Run the two suites only through the host heavy-run queue, from the WE checkout. Commands use checkout-relative arguments (paths above identify their repository):

```bash
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/__tests__/lane-verify.test.mjs scripts/__tests__/verify-lane.test.mjs
node scripts/readiness/heavy-admission.mjs run -- npm run check:standards
```

## Proof plan

Record queue output for the targeted suites and standards gate. Demonstrate test sensitivity with temporary, individually reverted mutations: change the default poll interval in `we:scripts/lib/lane-verify.mjs:417` and confirm the default-cadence case fails; replace the fresh CLI marker reader at `we:scripts/verify-lane.mjs:196` with a captured running snapshot and confirm the transition cases fail or reach their bounded timeout. Restore each mutation before the final green run. These are regression guards for currently correct behavior, so the unmodified implementation need not fail before the new tests exist.

Capture each integration result's exit code, SHA, status, settled flag and poll count, plus evidence that the marker update followed the first-sleep notification. A green first-poll result is not acceptable proof of a transition.

## Done when

Both owed rules are documented and exemplified by the new executable regressions. The queued targeted suites and standards gate pass, and the mutation checks demonstrate that default-cadence drift and cached polling state are detected. No test touches a shared lane marker or leaves a child process running.

## Follow-ups

Apply the same testing rules when other exported defaults or polling tools change; a repository-wide retroactive audit or AST-based test-coverage gate is outside this bounded debt. No dependency change is proposed. The runner owns preparation stamps and subsequent review checks.
