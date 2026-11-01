---
bornAs: xn1vafn
kind: story
size: 3
parent: "4075"
status: open
scope: ["plateau:scripts/wip-publish.ts", "plateau:scripts/__tests__/wip-publish.test.mjs", "plateau:src/wip/wip-agent-options.ts", "plateau:src/wip/wip-agent-options.test.ts", "we:docs/agent/testing.md"]
dateOpened: "2026-09-28"
preparedDate: "2026-11-01"
preparedAgainstSha: "ca7ff9f540cc832024b0dcb38108bf3a9a2e4a06"
tags: []
---

# File the prevention guard(s) owed by chalbert/plateau-app#187's independent review

Filed mechanically on approval of chalbert/plateau-app#187: preserve the live publisher's explicit polling cadence with an executable regression guard, and codify the review's requirement to turn manually probed timing fixes into fake-clock tests. The cadence fix itself has shipped; these prevention obligations remain.

Idempotency key (do not edit): approval-prevention-key:chalbert/plateau-app#187@c4b00de87f80f3b459211191d2a619b2026c87cd

## Progress

- Original premise/scope: the prior preparation located the live call at `plateau:scripts/wip-publish.ts:98-109`, cited generic scheduling at line 314, and proposed an options seam, two matching suites, and testing guidance. Earlier WE-local publisher paths were incorrect; the publisher belongs to plateau-app, not the abandoned plateau prototype.
- Corrected premise: at inspected Plateau HEAD `8b1d997e441317d706ebc105cc4cd23210ce73b9`, the live call is `plateau:scripts/wip-publish.ts:188` and its explicit override is at `plateau:scripts/wip-publish.ts:199`. The options module is still absent. `plateau:src/wip/wip-source.ts:30` sets 120,000 ms; `plateau:src/wip/wip-agent.ts:33,138,368` retains the 10,000 ms generic fallback and interval scheduling. The shipped override is not delivery of the missing regression guard.
- Scope correction: retain the five-file touch set, but distinguish agent read invocations from expensive recomputation. `plateau:scripts/wip-publish.ts:92-106` now routes reads through a source gate; removing the override proves excessive agent polling, not necessarily the historical CPU cost. HTTP/once use their own loop at `plateau:scripts/wip-publish.ts:125-138`. Do not redesign these gates or reassert old CPU measurements as current evidence.
- Caller search found the production call above and test callers at `plateau:src/wip/wip-agent.test.ts:47` and `plateau:src/wip/wip-feeds.test.ts:38`. The generic default remains unchanged; there is no persisted cadence state to migrate in this extraction. Existing cadence coverage at `plateau:src/wip/wip-source.test.ts:36-39` checks only the constant; `plateau:src/wip/wip-agent.test.ts:88-96` exercises generic defaults, not live assembly. HTTP-loop coverage in `plateau:src/wip/wip-publish.test.ts:105-121` is separate.
- Guidance moved to `we:docs/agent/testing.md:1458-1471`: default-argument and changing-target coverage exist, but the review's manually-probed-timing-to-fake-clock obligation is still missing. `plateau:vitest.config.ts:32` includes the proposed script-test extension.
- Size remains 3 (old 3 → new 3): approximately 15 changed lines in `plateau:scripts/wip-publish.ts`, 20 in planned `plateau:src/wip/wip-agent-options.ts`, 120 in planned `plateau:src/wip/wip-agent-options.test.ts`, 100 in planned `plateau:scripts/__tests__/wip-publish.test.mjs`, and 10 in `we:docs/agent/testing.md`. The extraction site and existing fake-clock harness at `plateau:src/wip/wip-agent.test.ts:25-63` support this estimate. No dependency changes or readiness stamps are authored here.

## Design

Add a pure live-publisher options assembler in planned `plateau:src/wip/wip-agent-options.ts`, accepting `Omit<AgentDeps, 'readEveryMs'>` and returning `AgentDeps`. Import the type from `plateau:src/wip/wip-agent.ts` and the cadence constant from `plateau:src/wip/wip-source.ts`. Spread dependencies first, then set `readEveryMs: PUBLISH_EVERY_MS`, so even an extra runtime property cannot override the publisher's cadence. Wrap the actual live call's object with this assembler in `plateau:scripts/wip-publish.ts`. Preserve every other dependency, feed, handler, watcher and staleness hook by identity. Keep the generic default and HTTP/once branches unchanged.

Feed assembled options into the real agent in behavioral tests. Add a source-wiring guard in planned `plateau:scripts/__tests__/wip-publish.test.mjs`: use the existing TypeScript parser to inspect imports and calls, require exactly one production call to the imported agent factory with the imported assembler as its direct sole argument, and require an object argument to that assembler. Reject outer spreads/overrides, bypasses, absent or duplicate calls, parse errors and unreadable source. Comments or unrelated identifier text must never satisfy the guard. Keep the checker local to this suite; an unsupported future syntax fails the test with the source path and a request to review/update the guard, never silently skips. Do not import the CLI, whose module evaluation loads credentials and starts work.

Extend the quality guidelines in `we:docs/agent/testing.md`: manually probed fixes to timer cadence, throttling or performance-related polling require deterministic fake-clock regression tests of production timing configuration and relevant boundaries. Include this publisher as the concrete example and explain why manual measurements corroborate but do not replace executable regression coverage.

## MVP

1. Add the options assembler and route the live publisher through it, preserving current runtime behavior.
2. Add the matching behavioral and wiring suites in scope, including adversarial evidence fixtures for the wiring guard.
3. Add the timing-regression guideline. No new policy settings, generic timing defaults, source-gate behavior or daemon lifecycle changes.

## Test plan

- In planned `plateau:src/wip/wip-agent-options.test.ts`, name cases `pins publisher cadence and preserves dependencies`, `reads only at publisher boundaries`, `slow read does not accumulate short-cadence polls`, and `watch still triggers before periodic boundary`. Check every supplied dependency identity and supply a conflicting runtime polling field to prove the assembler's final override wins.
- Use a fake socket opened at fake time zero and a settled startup read. Assert one startup read, no additional read through 119,999 ms, then exactly one at 120,000 ms and one at 240,000 ms. Also assert the assembled value equals `PUBLISH_EVERY_MS`; a shared accidental constant change must not silently bless a faster cadence.
- Hold the startup read for 25,000 fake milliseconds, resolve it, flush microtasks and assert no chained reads before 120,000 ms. A separate watcher case fires before that boundary and must read promptly. Count injected read calls, not sends or heavy cache misses. Stop the agent and restore real timers after every case.
- In planned `plateau:scripts/__tests__/wip-publish.test.mjs`, name cases `live publisher uses cadence assembler` and `wiring guard refuses incomplete or bypassed evidence`. Read the actual script from disk. Exercise bypass, override, comment-only decoy, missing/duplicate call, malformed source and injected read failure fixtures through the same checker. Fail with a diagnostic requiring guard review; there is no permissive fallback.
- Re-run existing `plateau:src/wip/wip-agent.test.ts`, `plateau:src/wip/wip-source.test.ts`, `plateau:src/wip/wip-publish.test.ts` and `plateau:src/wip/wip-feeds.test.ts` to protect the unchanged generic caller/default, watchers, feeds and HTTP behavior. Run through host heavy admission with Plateau root/config, never a bare test invocation.

## Acceptance

- [A1] Executable: planned `plateau:src/wip/wip-agent-options.test.ts` cases `pins publisher cadence and preserves dependencies` and `reads only at publisher boundaries` fail before the assembler exists and pass after implementation. They protect the live caller's 120-second interval while preserving dependencies; the existing generic-default test remains green.
- [A2] Executable: planned `plateau:src/wip/wip-agent-options.test.ts` cases `slow read does not accumulate short-cadence polls` and `watch still triggers before periodic boundary` fail before the seam exists and pass after it is implemented. Removing its override must make the slow-read and boundary assertions red; removing watcher forwarding must make the watcher assertion red.
- [A3] Executable: planned `plateau:scripts/__tests__/wip-publish.test.mjs` cases `live publisher uses cadence assembler` and `wiring guard refuses incomplete or bypassed evidence` fail against the pre-build script and pass after wiring. Bypass/outer-override mutations must fail the production-source check; negative fixtures must prove each fail-closed path actually rejects rather than being skipped.
- [A4] Executable: run `rg -n 'Manually probed timing fixes require deterministic fake-clock regression tests' we:docs/agent/testing.md` after resolving the repo prefix. It exits nonzero before the guideline addition and zero afterward. The added paragraph must also name production configuration and boundary coverage; review its meaning alongside this exact-text presence check.

## Proof plan

For the build, invoke `we:scripts/readiness/heavy-admission.mjs` with `run --wait-ms=60000 -- npx vitest run`, setting `--root` to the resolved Plateau checkout and `--config` to resolved `plateau:vitest.config.ts`; select the two planned suites and the four existing suites listed in Test plan. Resolve repo prefixes to paths before constructing argv; they are documentation notation, not literal filesystem paths. Record repository SHAs, exact executed argv, exit codes and selected test counts.

First run the new suites against the pre-build implementation and retain their red output. Then implement and show green. Temporarily remove the assembler override and separately bypass it at the production call; each relevant test must go red. Restore each mutation and rerun only affected suites. Use the negative wiring fixtures to establish fail-closed evidence handling. Run A4 before and after the documentation edit. Existing regression suites are preservation checks, not claims that already-working behavior was broken before this build.

Queue `npm run check:standards` through `we:scripts/readiness/heavy-admission.mjs` from WE. If capacity is unavailable, use the queue's single bounded wait and report the result without polling or bypassing admission. This preparation changes only the card; the runner owns stamping and preparation checks. No live daemon, credentials, CPU benchmark or network request is needed for the implementation's deterministic cadence proof.

## Follow-ups

None required for this prevention debt. Broader scanning of unrelated agent callers and renewed CPU profiling remain separate work requiring evidence. The event-driven source gates are deliberately outside this guard's guarantee: agent reads and expensive source recomputations are distinct observations.
