---
bornAs: x3ni496
kind: story
size: 2
status: open
scope: ["we:scripts/operations/__tests__/helpers/fake-claude.mjs", "we:scripts/operations/__tests__/fake-claude-sessions.test.mjs", "we:scripts/operations/__tests__/fake-claude-etxtbsy.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-07"
preparedAgainstSha: "45d426ce98ca541f7a2ed18ef1b9bdfac26fa506"
tags: []
---

# Fix flaky fake-claude-sessions test: ETXTBSY spawning the fake claude binary

The original report records CI run 36495657201 (PR #2875, 2026-09-28) failing in the scripted-actions group of `we:scripts/operations/__tests__/fake-claude-sessions.test.mjs` with `spawnSync claude ETXTBSY`. Preserve the goal: tolerate transient executable-busy failures in this fake's test execution seam, with deterministic regression coverage and 50 consecutive passing Linux runs.

## Design

The helper writes the executable synchronously and then makes it executable at `we:scripts/operations/__tests__/helpers/fake-claude.mjs:311-312`. There is no explicit retained write descriptor in this code. The historical CI symptom does not establish which process held a descriptor or that a fork inherited it. Treat that mechanism as an unverified hypothesis; neither an extra fsync nor rename is established as a fix by the current evidence.

Add a synchronous `retryEtxtbsy(fn)` helper in `we:scripts/operations/__tests__/helpers/fake-claude.mjs`. Return the callback result unchanged. Retry only errors whose `code` is exactly `ETXTBSY`, at most five attempts total, with 25 ms via `Atomics.wait` between attempts (four waits maximum). Rethrow the original final error; all other failures propagate immediately. Do not match message text, which could mistake a command's application error for a pre-execution failure.

Extend `createFakeClaude` with optional `execImpl = execFileSync` and returned `exec(cmd, argv, opts)` that invokes that implementation through the retry helper. Forward arguments and options unchanged on every attempt. In particular, do not rebuild the environment inside this wrapper: the production spawner's token sanitization must survive it.

Route every fake executable invocation in `we:scripts/operations/__tests__/fake-claude-sessions.test.mjs` through the corresponding instance's `exec`:

- Pass `{ exec: fake.exec }` as the third argument to `defaultSpawnAgent`, whose injection point is `we:scripts/operations/dispatch-lane-io.mjs:1839`.
- Pass `exec: fake.exec` alongside the existing environment to `defaultListAgents`, whose fetch seam is `we:scripts/operations/dispatch-lane-io.mjs:3273`.
- Keep the stop adapter's environment merge, but call `fake.exec(cmd, args, { ...opts, env })` instead of the bare executor. `stopSession` supplies no environment itself at `we:scripts/operations/dispatch-abort.mjs:72-76`.
- Replace the direct token-observation invocation at `we:scripts/operations/__tests__/fake-claude-sessions.test.mjs:140`; also cover the separate `local` instance in the cleanup case at `we:scripts/operations/__tests__/fake-claude-sessions.test.mjs:202-204`.

Production spawn, listing, and stop implementations remain the exercised behavior; the retry sits below their existing injection seams. The helper's existing callers remain compatible.

## MVP

1. Implement the bounded retry and instance executor in `we:scripts/operations/__tests__/helpers/fake-claude.mjs`, including the helper's return/options documentation.
2. Route all existing session-suite executable calls through it in `we:scripts/operations/__tests__/fake-claude-sessions.test.mjs`, preserving environments, timeouts, fault expectations, and cleanup.
3. Add pure deterministic wrapper tests in planned `we:scripts/operations/__tests__/fake-claude-etxtbsy.test.mjs`; put real-process retry/routing cases in existing `we:scripts/operations/__tests__/fake-claude-sessions.test.mjs`.

This is one test-infrastructure fix. No production retry, file-publication redesign, or migration of other consumers is required.

## Test plan

Matching coverage for `we:scripts/operations/__tests__/helpers/fake-claude.mjs` is the planned unit file `we:scripts/operations/__tests__/fake-claude-etxtbsy.test.mjs` plus the existing integration file `we:scripts/operations/__tests__/fake-claude-sessions.test.mjs`; both are explicitly in scope.

In the unit file, prove first-attempt success, two ETXTBSY failures then success (three calls), exhaustion (five calls and identical final error), immediate ENOENT/application-error propagation (one call), and no retry for a message containing ETXTBSY without that error code. Use an injected executor with `createFakeClaude` to verify argument/options forwarding and return/error identity; clean the fixture in a finally block. These tests may create temporary files but must not spawn children.

In the integration file, inject an executor that throws a coded ETXTBSY once before delegating to real `execFileSync` for each exercised spawn/list/stop/direct invocation. Count attempts so a cache hit cannot falsely prove listing retry. Use a fresh fixture/environment and ensure the list fetch actually executes. Assert one session is created, listing returns it, stop succeeds, direct token observation still works, and cleanup kills recorded children. Keep the existing sanitized-token and deliberate-fault assertions intact. Inspect all executable call sites, including the local cleanup fixture, for unwrapped calls.

The unit glob already includes the planned file (`we:vitest.config.ts:121`). The session suite is excluded from that tier (`we:vitest.config.ts:273`) and included in the integration tier (`we:vitest.integration.config.ts:120`); no configuration edit is needed.

## Proof plan

Execution belongs to the implementation phase; preparation does not claim the flake reproduced or tests passed. Run all tests and gates through the host heavy-run queue entry point `we:scripts/readiness/heavy-admission.mjs`. Commands below use repository-prefixed path notation: remove the `we:` notation when passing each path to the shell from the WE checkout.

- Unit: `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/fake-claude-etxtbsy.test.mjs`.
- Integration: `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run --config we:vitest.integration.config.ts we:scripts/operations/__tests__/fake-claude-sessions.test.mjs`.
- Standards: `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards`.

Demonstrate red/green by bypassing the retry in the implementation workspace: injected ETXTBSY cases must fail, then pass with the retry restored. On a Linux checkout with dependencies installed, execute the queued integration command 50 times sequentially, stopping at the first failure; record OS, Node version, tested SHA, commands, and pass count. Do not bypass admission with a container or a bare test loop. Require the relevant CI integration check as well; a generic unit check does not select this suite. A macOS pass is only a smoke check. Fifty green runs provide stress evidence, not proof of the hypothesized descriptor race or impossibility of future flakes.

## Follow-ups

- Separately assess other consumers of `createFakeClaude` and the older `withFakeClaude` helper in `we:scripts/operations/__tests__/helpers/fake-claude.mjs:207`; migrate only where evidence warrants it.
- If ETXTBSY survives the bounded retry, capture Linux process/descriptor evidence before changing executable publication or retry limits.
- Consider a periodic Linux stress check separately from this bounded repair.

## Done when

The deterministic tests prove retry classification, boundedness, forwarding, and failure preservation; every session-suite fake executable call uses the wrapper; the existing behaviors remain green; and the queued Linux integration run passes 50 consecutive times with evidence recorded.

## Progress

- Historical preparation (2026-09-30) reported a discarded 210-line implementation exceeding the automated 150-line test-fix envelope. That report is history, not evidence that a fix landed. Current inspection finds neither `retryEtxtbsy` nor an instance executor in `we:scripts/operations/__tests__/helpers/fake-claude.mjs:298-366`.
- Old premise: an open writer/fork-inheritance race was asserted as the cause, and closing/fsync/rename was initially offered as a fix. Corrected premise: the helper uses sequential synchronous write/chmod at `we:scripts/operations/__tests__/helpers/fake-claude.mjs:311-312`; the responsible writer was not observed. Retain the already-proposed bounded test-only retry as mitigation, without asserting a root cause.
- Old scope was the entire `we:scripts/operations/__tests__/` directory. Corrected scope names the helper, existing session integration suite, and planned unit regression file explicitly. The production injection seams already exist at `we:scripts/operations/dispatch-lane-io.mjs:1839`, `we:scripts/operations/dispatch-lane-io.mjs:3273`, and `we:scripts/operations/dispatch-abort.mjs:72`, so no production edits are required. The old spawn citation at `we:scripts/operations/dispatch-lane-io.mjs:1752` is replaced above.
- Corrected test placement: pure retry coverage belongs in the planned unit file; real-process routing coverage belongs in the existing integration suite, as established by `we:vitest.config.ts:273` and `we:vitest.integration.config.ts:120`. The earlier plan put both in the unit tier and supplied commands with an unusable repository prefix as a literal CLI path.
- Size remains 2: one helper, one existing consumer suite, one focused new test file; no new production API or configuration work. Preparation leaves the existing stamps untouched for the runner and proposes no blockedBy changes.

## Findings (standalone worker, 2026-10-07)

The build-dispatch daemon held #4388 with:

> worker-declined: scope exceeds the test-fix envelope — route to the builder: the heal changed 237 lines (limit 150)

Implementation changes were discarded. The card is held for the builder; its declared scope is preserved.
