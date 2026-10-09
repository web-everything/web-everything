---
bornAs: xn1vafn
kind: story
size: 3
parent: "4075"
status: open
scope: ["plateau:scripts/wip-publish.ts", "plateau:scripts/__tests__/wip-publish.test.mjs", "plateau:src/wip/wip-agent-options.ts", "plateau:src/wip/wip-agent-options.test.ts", "we:docs/agent/testing.md"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-08"
preparedAgainstSha: "89f3e62f7a33df7c97ac05a2cddd532344cd4036"
tags: []
---

# File the prevention guard(s) owed by chalbert/plateau-app#187's independent review

Filed mechanically on approval of chalbert/plateau-app#187: preserve the live publisher's explicit polling cadence with an executable regression guard, and codify the review's requirement to turn manually probed timing fixes into fake-clock tests. The cadence fix itself has shipped; these prevention obligations remain.

Idempotency key (do not edit): approval-prevention-key:chalbert/plateau-app#187@c4b00de87f80f3b459211191d2a619b2026c87cd

## Progress

- Original premise/scope: the publisher and a matching test belonged at `we:scripts/wip-publish.ts` and `we:scripts/__tests__/wip-publish.test.mjs`; the historical references named lines 109 and 111 and suggested either extracting options or adding a broad standards rule.
- Corrected premise/scope: neither WE path exists. The production call is `plateau:scripts/wip-publish.ts:98`, and its explicit `readEveryMs: PUBLISH_EVERY_MS` remains at `plateau:scripts/wip-publish.ts:109`. Line 111 is now a decision-forks handler, not a timing rule. Plateau commit `fb430d0` delivered the cadence fix, not this prevention work. Inspected Plateau HEAD: `2e9ae55b4460693ff54294cadf958e065de44e7e`.
- Evidence of the remaining gap: `plateau:src/wip/wip-source.test.ts:36-39` checks only that the constant is at least 120 seconds. `plateau:src/wip/wip-agent.test.ts:46-63` constructs the generic agent with fake dependencies; its timer case at lines 88-96 exercises the generic default, not production options. `plateau:src/wip/wip-agent.ts:127` falls back to its own default when the override is omitted; line 314 schedules that interval. Existing HTTP-loop tests in `plateau:src/wip/wip-publish.test.ts:105-121` do not exercise the live-agent assembly.
- Corrected scope includes a small production options seam and its behavioral suite, a planned script-wiring test, and the testing guideline in `we:docs/agent/testing.md`. The existing guidance at `we:docs/agent/testing.md:331-344` covers defaults and polling transitions, but does not require converting manually measured timing fixes into automated timing regressions. This is documentation of the obligation already named by the review, not a new blanket rule for all agent callers.
- Size remains 3: one small extraction at `plateau:scripts/wip-publish.ts:98-109`, focused tests using the existing fake-clock pattern at `plateau:src/wip/wip-agent.test.ts:54-63`, and one guideline addition. No dependency changes are proposed.

## Design

Extract the live-agent cadence choice into a pure options assembler in planned `plateau:src/wip/wip-agent-options.ts`. Accept the existing agent dependencies except the polling override and return dependencies with `readEveryMs` set to `PUBLISH_EVERY_MS`; apply that field after the input spread so it cannot be accidentally overwritten. Import the constant from `plateau:src/wip/wip-source.ts`. Route the actual live `createAgent` call in `plateau:scripts/wip-publish.ts` through this assembler while preserving all handlers, watchers, staleness hooks, and HTTP/once branches.

The behavioral test must feed the assembler's result into the real agent, rather than independently passing the expected constant. Add a focused source-wiring guard for the script so bypassing the assembler also fails. Do not import the side-effectful CLI into a unit test: token loading, process exits, and live connections begin at module evaluation.

Extend `we:docs/agent/testing.md` quality guidelines: a manually probed fix to timer cadence, throttling, or performance-related polling must include deterministic fake-clock regression coverage of the production timing configuration and relevant boundary behavior. Manual measurements remain useful corroboration; they do not replace the regression. This does not change the generic agent's default or impose an unrelated standards scanner on all scripts.

## MVP

1. Add the pure assembler and wire the production live branch through it.
2. Add planned `plateau:src/wip/wip-agent-options.test.ts` for configuration and real-agent timing, and planned `plateau:scripts/__tests__/wip-publish.test.mjs` for production wiring. These are the matching tests for the two source entries in scope; the documentation entry needs review, not an artificial unit test.
3. Add the testing guideline and its concrete publisher example. Preserve existing timer, watcher, and HTTP semantics.

## Test plan

- Assembler: assert the returned polling interval equals `PUBLISH_EVERY_MS` and preserves injected dependency identities.
- Real agent with assembled options, fake WebSocket, fake read, and fake timers: after startup settles, assert no additional periodic read before `PUBLISH_EVERY_MS - 1`, exactly one at the boundary, and another at the next boundary. Count reads, not snapshot sends, because unchanged snapshots are suppressed.
- Include a 25-second deferred read under fake time: it must not create continuous reads at the generic shorter cadence; the next periodic read remains at the configured boundary. With a separate watcher stimulus, verify a change can still trigger a read before that boundary. Stop the agent and restore timers after each case.
- Script guard: examine executable wiring (ignore comments), require that the live `createAgent` receives the assembler result, and reject a later inline polling override. Verify the guard rejects a fixture with the assembler bypassed. Use the existing script-test extension included by `plateau:vitest.config.ts`.
- Re-run existing `plateau:src/wip/wip-agent.test.ts`, `plateau:src/wip/wip-source.test.ts`, and `plateau:src/wip/wip-publish.test.ts` alongside the two new suites. Execute only via the host heavy-run queue, with Vitest rooted/configured for Plateau. Run WE standards through the same queue.

## Proof plan

The implementation's executable acceptance is a queued Vitest run selecting the two new suites and the three existing suites listed above. Invoke the queue through `we:scripts/readiness/heavy-admission.mjs` with Vitest's root and config targeting the Plateau checkout; use repository-local paths as CLI arguments after resolving the repository prefixes. Also queue `npm run check:standards` from WE.

Demonstrate red/green by temporarily removing the assembler's polling override: the cadence tests must fail as the real agent falls back to its shorter interval. Separately bypass the assembler at the production call: the script-wiring guard must fail. Restore each mutation and show all selected suites green. Record commands, results, and tested repository SHAs when implementing. No daemon restart, credentials, network connection, or host CPU benchmark is needed to establish this deterministic regression guard.

## Done when

Both regressions fail under their respective mutations and pass with the production assembly intact; the existing suites remain green; the testing guideline explicitly captures the review's fake-clock obligation; and the queued WE standards check passes.

## Follow-ups

None required for this prevention debt. Broader enforcement across unrelated agent callers or renewed host CPU profiling would be separate work supported by a concrete need. This preparation does not implement the guard, claim delivery, or stamp readiness.
