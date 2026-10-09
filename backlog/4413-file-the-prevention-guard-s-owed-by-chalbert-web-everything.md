---
bornAs: x56mcj7
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/lease-reaper.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-09"
preparedAgainstSha: "1c5dc7c02cbea88fa7727cbe278d66b4ce00e278"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2870's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval"). The approval owed a deterministic no-execution assertion in the session-axis opt-out test, currently at `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:896`.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2870@7911dc9462526db99e56d2ded8031fd37a6ff7fd

## Progress

- Rechecked against lane HEAD `1c5dc7c02cbea88fa7727cbe278d66b4ce00e278`: the owed guard is not delivered. The opt-out test at `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:896-901` still supplies an untracked throwing stub and asserts only null states and agents. This is source evidence, not an executed mutation result.
- Old premise/scope: the prior preparation cited the test at `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:869-874`, the opt-out/catch at `we:scripts/conveyor/lease-reaper.mjs:1299-1306`, and the cached listing at `we:scripts/operations/dispatch-lane-io.mjs:3351-3364`; its scope was one test file with explicit cache isolation. Corrected premise/scope: the test moved to `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:896-901` and the opt-out/catch moved to `we:scripts/conveyor/lease-reaper.mjs:1340-1347`. The listing location is unchanged. Both production branches still return the same null/empty-map result, so the original throwing stub cannot distinguish them. The single-file implementation scope remains correct.
- Cache isolation remains necessary for deterministic mutation proof: `we:scripts/lib/claude-agents-cache.mjs:7-17` disables caching under tests by default, but an explicit positive TTL overrides that default; a fresh cache returns without calling exec at `we:scripts/lib/claude-agents-cache.mjs:25-28`. Set the TTL to zero and restore the prior environment exactly.
- Scope already names the matching existing test, `we:scripts/conveyor/__tests__/lease-reaper.test.mjs`; no production source change is planned. Production paths below are research and temporary mutation targets only. Size remains 3 for the isolated assertion change, environment cleanup, and before/after mutation proof. No dependency changes are proposed; no unresolved policy or design fork was found.
- The neighboring PR-axis follow-up citations also moved: the throwing-stub tests are now at `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:1072-1079`, with their REST-backed opt-out/read/catch at `we:scripts/conveyor/lease-reaper.mjs:1277-1299`.
- Preparation edits only this card. Tests and mutation proof are delivery work specified below, not results claimed here; the probation runner owns preparation checks, stamping, and the parked independent review. Existing preparation metadata is left unchanged for that runner.

## Done when

1. **Must 1:** The opt-out test retains null `states` and `agents`, asserts an empty `pidAlive` Map and zero exec calls, with the cache explicitly disabled and the prior environment restored even on assertion failure.
2. **Must 2:** Queued mutation proof records original-test green, strengthened-test red specifically on the no-call assertion, and restored-source green. The full matching test file and standards check pass through the host heavy-run queue. The delivered implementation diff contains only the intended test changes, with no production mutation.

## Design

Strengthen the existing test at `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:896-901`; `vi` is already imported at `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:21`. Wrap the existing throwing implementation in `vi.fn(() => { throw new Error('must not be called'); })`. Preserve its failure behavior: if the opt-out return is removed, the call is recorded before the exception is caught. Retain both null assertions, add `expect(result.pidAlive.size).toBe(0)`, and add `expect(exec).not.toHaveBeenCalled()`.

Within this test, save the prior `process.env.WE_CLAUDE_AGENTS_CACHE_TTL_MS`, set it to `'0'`, and restore its exact prior value in `finally` (delete the key if originally absent). This bypasses cache reads and writes via `we:scripts/lib/claude-agents-cache.mjs:16-17`, including hosts with an explicit positive TTL. Keep the environment setup local to this synchronous test.

The existing seam is `fetchSessionSignals(flags, { exec })` at `we:scripts/conveyor/lease-reaper.mjs:1339`: passing `{ 'no-check-sessions': true }` must return `{ states: null, pidAlive: new Map(), agents: null }` without invoking exec. No API, runtime behavior, consumers, or data migration change. Ship the test and its isolation together as one small change; sibling PR-axis guards remain follow-up work.

## MVP

1. **Must 1:** Add local cache isolation, the throwing spy, and the empty-map/zero-call assertions to the single session opt-out test in `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:896-901`.
2. **Must 2:** Execute the Proof plan, restore only temporary proof changes, and capture command exit statuses plus the relevant test output for independent review. Then run the full test file and standards check through the queue.

## Test plan

- Focus the test in `we:scripts/conveyor/__tests__/lease-reaper.test.mjs` with the name filter `no-check-sessions disables`. Assert both result compatibility and the absence of execution, without real subprocess calls.
- Validate the mutation's failure comes from the exec-call assertion, not an import, environment, or unrelated test failure. Retaining the throwing spy makes the caught-error result identical to the opt-out result, isolating the missing guard as the reason for red.
- Run the complete `we:scripts/conveyor/__tests__/lease-reaper.test.mjs` after restoring the source. Its adjacent failed-listing, interactive-only-listing, and malformed-listing cases must remain green.
- All test and standards invocations use `we:scripts/readiness/heavy-admission.mjs` with `run --`. From the WE checkout, pass `npx vitest run` the repository-relative form of `we:scripts/conveyor/__tests__/lease-reaper.test.mjs`, optionally followed by `-t "no-check-sessions disables"`; pass `npm run check:standards` for the standards gate. Strip the documentation-only `we:` prefix when passing filesystem arguments.

## Proof plan

1. Before implementation, preserve the exact contents of `we:scripts/conveyor/lease-reaper.mjs` and the target test. Set `WE_CLAUDE_AGENTS_CACHE_TTL_MS=0` for each proof command so the original test also bypasses host cache state. Run the original focused test through the queue for baseline green.
2. Temporarily remove only the `flags['no-check-sessions']` early return at `we:scripts/conveyor/lease-reaper.mjs:1340`. Run the original focused test through the queue: expected green despite the exec attempt, demonstrating the gap. If that expectation fails, investigate before claiming proof.
3. Apply Must 1 to the test with the same source mutation present. Run the focused test through the queue: expected red on `expect(exec).not.toHaveBeenCalled()`, reporting at least one recorded call. The null/empty-result assertions should still pass because the spy throws into the catch.
4. Restore only the saved source line/content, preserving any unrelated lane edits; do not use a blanket checkout. Rerun the strengthened focused test, then the full matching file and standards check through the queue: expected green. Confirm the production file has no residual mutation and the delivered test change retains cache cleanup.
5. Record actual commands, exit statuses, and the assertion failure in delivery evidence. The independent reviewer must confirm the red failure is the intended regression gate. No proof run is claimed by this preparation.

## Follow-ups

- Separate work may strengthen the analogous throwing-stub tests at `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:1072-1079`. Their current production path is REST-backed: `we:scripts/conveyor/lease-reaper.mjs:1277-1299` invokes `ghRestGetPaged` inside a catch. Recheck that path's cache/transport isolation before adopting a spy; the older direct-call assumption is stale.
- A broader lint rule for throwing no-call stubs would require its own scope and false-positive analysis. It is not necessary for this single owed guard.
