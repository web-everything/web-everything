---
bornAs: x0bbh38
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "bdcf17b75673b6d6f0673952f1c89b5d81c93973"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2991's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. Preserve executor attribution when a claim and a durable run record describe the same item; cover the complete daemon-to-policy path.
2. Guard each provider's below/at/above-cap behavior, including independence when the other capacity pool is full.
3. Guard the daemon's emitted stdout tick JSON against silent changes to existing field types.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2991@e829553edb1b8ab621ccf4df8fdef4f86286c134

## Acceptance

The named tests below are proposed additions, not claims of existing passing coverage. Each executable must fail with its corresponding regression mutation and pass after restoration; the prevention assertions may already pass against correct production behavior. Run them through the queued command in Proof plan, selecting the named test with `-t` when demonstrating a mutation.

- [A1] Executable: `4536 duplicate claim/run retains attribution` in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` exercises the real tick-to-policy path for Claude, Codex, Antigravity and a legacy missing executor. Assert one normalized item, unioned scopes, exactly one capacity charge and no redispatch. Dropping executor retention in the merge must fail the known-executor cases.
- [A2] Executable: `4536 provider capacity matrix` in `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs` covers each provider below/at/above its pool cap, with the other pool empty/full, default caps 1/4 and custom caps 2/3. Assert dispatch below cap and rule `cap` at/above it, shared external consumption and clamped zero headroom above cap. Coupling pools or changing default caps must fail.
- [A3] Executable: `4536 conservative routing and legacy capacity` in `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs` pins absent/unknown executor attribution to Claude, omitted external-cap fallback to four, and route-error refusal with no dispatch. Ignoring unknown occupancy, removing the fallback or allowing a failed prediction must fail. These are existing conservative paths; introduce no new policy or fallback.
- [A4] Executable: `4536 stdout tick contract` and `4536 live callback uses tick writer` in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` capture the production writer's bytes and pin its live caller. Cover populated/empty output, optional pass errors, undefined omission, nulls, field types and one trailing newline. Reverting `inFlight` to bare numbers or bypassing the tested writer must fail. A missing-plan tick must emit no stdout record and retain its stderr skip diagnostic. No defaults or callers change behavior.

## Progress

Preparation refresh (2026-11-18; runner owns stamping):

- **Old premise/scope:** the prior preparation already scoped three files and correctly treated executor preservation as implemented, but cited obsolete locations (daemon merge lines 365–379, policy lines 220–225, stdout lines 1471–1477) and listed only the earlier stdout fields. Its run-store-only test citation and route/cap test location were stale. The original review's deduplication defect is now prevention debt, not a request to reimplement the merge.
- **Corrected premise and evidence:** claim rows and durable run rows reach the policy at `we:skills-src/conveyor/build-dispatch-daemon.mjs:775-779`; the executor-preserving merge and separate pool counts are at `we:scripts/conveyor/build-dispatch-policy.mjs:243-260`. The existing policy examples at `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs:400-440` cover default boundaries, independence, failed prediction, both merge orders and conservative unknown attribution, but not the full matrix. The daemon test at `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:636-651` supplies only a run row, not a matching claim. The real claim harness is at `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:540-553`.
- **Output drift:** serialization remains inline in the live callback at `we:skills-src/conveyor/build-dispatch-daemon.mjs:3134-3143`. It now includes timings, build holds, needs-you results, queue pruning, load/cost admission, launch settlement/policy, same-tick holds and capacity. `tickCapacity` at `we:skills-src/conveyor/build-dispatch-daemon.mjs:2916-2922` supplies the current nested projection. Targeted searches found no stdout contract snapshot in the daemon suite. The three-part goal is therefore not already delivered.
- **Corrected scope:** retain exactly the three existing scoped files; policy source is evidence and a temporary mutation target only. Extract only the live stdout writer and guard its caller; do not alter dry-run output, routing, grouping or capacity policy. No dependency change is proposed.
- **Sizing:** retain story size 3 (old 3 → new 3). Estimate approximately 30 changed lines for the writer/caller around `we:skills-src/conveyor/build-dispatch-daemon.mjs:3141`, 140 for daemon regression fixtures/assertions alongside `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:636`, and 70 for policy tables alongside `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs:400`: about 240 changed lines across three files. This is a story, so no `estimatedLoc` is added.

## Design

Use the existing policy merge as the single deduplication implementation. Add a daemon regression that supplies a real temporary claim and a run-store row for the same normalized item number, then exercises `runBuildDispatchTick` with injected effects. Assert one merged entry, retained executor, unioned scope, and no redispatch of that item.

Extend the existing policy suite with a table over candidate executors `claude`, `codex`, and `antigravity`, own-pool occupancy at cap minus one, cap, and cap plus one, and other-pool occupancy empty or full. Codex and Antigravity share the external pool; unknown executors continue to consume Claude capacity. Use disjoint scopes, prepared candidates, no open PRs/freeze, and a sufficiently high own-item WIP cap so unrelated gates cannot mask the concurrency assertion.

For stdout, extract the existing serialization/write operation into an exported helper in `we:skills-src/conveyor/build-dispatch-daemon.mjs`, used by the live callback, with injectable writer and time, taking the existing loop timing argument. Keep the missing-plan guard and cost-admission stderr diagnostic in the live callback. Add a source-wiring assertion using the existing suite pattern to ensure the live callback invokes this writer and guards missing plans before calling it. Preserve the current JSON projection exactly. Add an inline snapshot in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` using fixed time and representative tick results. This is a test seam for the existing output contract, not a new schema or output format. Assert exactly one newline-terminated JSON record and parse the captured bytes; do not snapshot a separately reconstructed imitation of the payload.

## MVP

1. Add the daemon duplicate-evidence regression for known executors and a legacy row without executor, retaining existing retirement and in-flight hold behavior.
2. Add the provider boundary matrix alongside the existing policy examples; preserve the existing within-tick shared-external-slot test.
3. Extract and wire the stdout writer; snapshot populated and empty tick output, including `inFlight` objects with string `num` and string-or-null `executor`. Cover current fields `at`, `status`, `freeze`, `openItems`, `dispatched`, `prepare`, `hold`, `dispatchHolds`, `failures`, `retired`, `infraRetry`, `orphanAdoption`, `draftRecovery`, `holdRouting`, and `holdRoutingResult`, plus `timings` (including loop), `buildHolds`, `needsYou`, `queuePrune`, `loadHolds`, `costAdmission`, `launchSettlement`, `launchPolicy`, `sameTickHolds`, and `capacity`, preserving current null values and JSON omission of undefined properties. Include successful and error-shaped optional pass results.

## Test plan

- `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`: use the existing temporary claim/effects harness, keep the duplicate item live in the fixture, and verify the merged plan rather than just the run-store reader. Assert the expected capacity pool is charged once.
- `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs`: parameterize the 3 × 3 × 2 boundary matrix above. Below cap dispatches; at/above cap holds with rule `cap`, regardless of the other pool. Exercise both default and custom cap values, mixed external occupants, and the existing conservative unknown-executor behavior.
- `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`: capture the production writer's bytes with deterministic time and inline snapshots, including empty/populated `inFlight` and null executor. Ensure the live callback calls this tested writer. No live daemon, GitHub calls, or real dispatch is needed.

## Proof plan

Implementation verification uses the host queue. In the WE checkout, set shell variables `queue=we:scripts/readiness/heavy-admission.mjs`, `daemonTest=we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` and `policyTest=we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs`; strip the documentation locus only at execution: `node "${queue#we:}" run -- npx vitest run "${daemonTest#we:}" "${policyTest#we:}"`. Append `-t '4536'` for the new acceptance tests; use their individual names for mutation evidence. Run the standards check through `node "${queue#we:}" run -- npm run check:standards`. If admission is busy, wait once using the queue's supported wait option, then stop and report. Preparation leaves execution and stamping to the runner.

Demonstrate sensitivity with temporary mutations during implementation: remove executor retention from the policy merge and observe the duplicate-evidence regression fail; charge external occupancy to Claude and observe matrix failures; serialize `inFlight` as bare item numbers and observe the stdout snapshot fail. Also mutate the legacy external-cap fallback, unknown-executor classification and route-error refusal independently for A3, and bypass the live writer for A4. Restore each mutation and rerun the focused suites; no mutation belongs in the delivered diff. A new prevention test may pass immediately against already-correct behavior; mutation failure supplies the missing red evidence without inventing a current production defect. Review the final diff to confirm the live callback uses the tested writer and no stdout keys or types changed.

## Follow-ups

No additional policy decision or child item is needed. Future intentional tick-output changes must update the output contract test with review of compatibility. Broader daemon-output versioning, routing changes, and cap-default changes are outside this prevention item.
