---
bornAs: x56mcj7
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/lease-reaper.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-07"
preparedAgainstSha: "a02673b29fe1efcd1ac806c08089df59bebb04b7"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2870's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval"). The approval owed a deterministic no-execution assertion in the session-axis opt-out test, currently at `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:867`.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2870@7911dc9462526db99e56d2ded8031fd37a6ff7fd

## Progress

- Research against lane HEAD `a02673b29fe1efcd1ac806c08089df59bebb04b7`: the guard is not already delivered. The original review cited `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:841`; the previous preparation cited line 866. The current test is at `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:867-872`: it supplies a throwing stub and asserts only null states and agents, without checking calls.
- Old premise/scope: replacing the stub with a spy alone necessarily detects removal of the early return; one test file changes. Corrected premise/scope: retain that one-file test-only scope, but explicitly bypass the listing cache during the test so the mutation necessarily reaches the injected spy. `we:scripts/conveyor/lease-reaper.mjs:1271-1278` contains the opt-out return and the catch returning the same result shape; `we:scripts/operations/dispatch-lane-io.mjs:3273-3287` now routes the injected exec through `cachedClaudeAgents`. `we:scripts/lib/claude-agents-cache.mjs:7-17` disables caching under tests by default, but an explicit positive TTL overrides that default; a fresh cache can return without calling exec at `we:scripts/lib/claude-agents-cache.mjs:25-28`.
- Scope already names the matching existing test, `we:scripts/conveyor/__tests__/lease-reaper.test.mjs`; there is no shipped source change requiring another test path. Production files cited here are research and temporary mutation targets only. Size remains 3 for the isolated assertion change, environment isolation, and before/after mutation proof. No dependency changes are proposed.
- Evidence above is source inspection, not an executed mutation result. The prior preparation's assertion that the original test passes under mutation remains to be measured using the Proof plan. This preparation changes only this card; the runner owns checks, stamping, and independent review.

## Done when

1. **Must 1:** The opt-out test retains null `states` and `agents`, asserts an empty `pidAlive` Map and zero exec calls, with the cache explicitly disabled and the prior environment restored even on assertion failure.
2. **Must 2:** Queued mutation proof records original-test green, strengthened-test red specifically on the no-call assertion, and restored-source green. The full matching test file and standards check pass through the host heavy-run queue. The delivered implementation diff contains only the intended test changes, with no production mutation.

## Design

Strengthen the existing test at `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:867-872`; `vi` is already imported at `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:21`. Wrap the existing throwing implementation in `vi.fn(() => { throw new Error('must not be called'); })`. Preserve its failure behavior: if the opt-out return is removed, the call is recorded before the exception is caught. Retain both null assertions, add `expect(result.pidAlive.size).toBe(0)`, and add `expect(exec).not.toHaveBeenCalled()`.

Within this test, save the prior `process.env.WE_CLAUDE_AGENTS_CACHE_TTL_MS`, set it to `'0'`, and restore its exact prior value in `finally` (delete the key if originally absent). This bypasses cache reads and writes via `we:scripts/lib/claude-agents-cache.mjs:16-17`, including hosts with an explicit positive TTL. Keep the environment setup local to this synchronous test.

The existing seam is `fetchSessionSignals(flags, { exec })` at `we:scripts/conveyor/lease-reaper.mjs:1270`: passing `{ 'no-check-sessions': true }` must return `{ states: null, pidAlive: new Map(), agents: null }` without invoking exec. No API, runtime behavior, consumers, or data migration change. Ship the test and its isolation together as one small change; sibling PR-axis guards remain follow-up work.

## MVP

1. **Must 1:** Add local cache isolation, the throwing spy, and the empty-map/zero-call assertions to the single session opt-out test in `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:867-872`.
2. **Must 2:** Execute the Proof plan, restore only temporary proof changes, and capture command exit statuses plus the relevant test output for independent review. Then run the full test file and standards check through the queue.

## Test plan

- Focus the test in `we:scripts/conveyor/__tests__/lease-reaper.test.mjs` with the name filter `no-check-sessions disables`. Assert both result compatibility and the absence of execution, without real subprocess calls.
- Validate the mutation's failure comes from the exec-call assertion, not an import, environment, or unrelated test failure. Retaining the throwing spy makes the caught-error result identical to the opt-out result, isolating the missing guard as the reason for red.
- Run the complete `we:scripts/conveyor/__tests__/lease-reaper.test.mjs` after restoring the source. Its adjacent failed-listing, interactive-only-listing, and malformed-listing cases must remain green.
- All test and standards invocations use `we:scripts/readiness/heavy-admission.mjs` with `run --`. From the WE checkout, pass `npx vitest run` the repository-relative form of `we:scripts/conveyor/__tests__/lease-reaper.test.mjs`, optionally followed by `-t "no-check-sessions disables"`; pass `npm run check:standards` for the standards gate. Strip the documentation-only `we:` prefix when passing filesystem arguments.

## Proof plan

1. Before implementation, preserve the exact contents of `we:scripts/conveyor/lease-reaper.mjs` and the target test. Set `WE_CLAUDE_AGENTS_CACHE_TTL_MS=0` for each proof command so the original test also bypasses host cache state. Run the original focused test through the queue for baseline green.
2. Temporarily remove only the `flags['no-check-sessions']` early return at `we:scripts/conveyor/lease-reaper.mjs:1271`. Run the original focused test through the queue: expected green despite the exec attempt, demonstrating the gap. If that expectation fails, investigate before claiming proof.
3. Apply Must 1 to the test with the same source mutation present. Run the focused test through the queue: expected red on `expect(exec).not.toHaveBeenCalled()`, reporting at least one recorded call. The null/empty-result assertions should still pass because the spy throws into the catch.
4. Restore only the saved source line/content, preserving any unrelated lane edits; do not use a blanket checkout. Rerun the strengthened focused test, then the full matching file and standards check through the queue: expected green. Confirm the production file has no residual mutation and the delivered test change retains cache cleanup.
5. Record actual commands, exit statuses, and the assertion failure in delivery evidence. The independent reviewer must confirm the red failure is the intended regression gate. No proof run is claimed by this preparation.

## Follow-ups

- Separate work may strengthen the analogous throwing-stub tests at `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:1043-1050`. Their current production path is REST-backed: `we:scripts/conveyor/lease-reaper.mjs:1209-1230` invokes `ghRestGetPaged` inside a catch. Recheck that path's cache/transport isolation before adopting a spy; the older direct-call assumption is stale.
- A broader lint rule for throwing no-call stubs would require its own scope and false-positive analysis. It is not necessary for this single owed guard.
