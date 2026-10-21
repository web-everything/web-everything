---
bornAs: xttbqyt
kind: task
status: open
scope: ["we:scripts/worker-brief.mjs", "we:scripts/__tests__/worker-brief.test.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Worker brief: wait for heavy-admission instead of giving up

Make the worker brief spell out the heavy-wrapper command and an honest exit-75 handback. The wrapper already waits for capacity but can defer immediately on host overload; a finished exit-75 process is not an ongoing action to poll. Permit bounded waiting only while the worker’s own sanctioned queue action is still running, otherwise require the exact lane, full SHA and command with TESTS NOT RUN. Keep admission behavior unchanged.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/__tests__/worker-brief.test.mjs` — assert the rendered brief includes the repository-root command `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <test-file>`, ties exit 75 to TESTS NOT RUN, and puts lane/full SHA/exact retry command first in a deferred report. These text/contract assertions fail against the current brief.
- [A2] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/readiness/__tests__/heavy-admission.test.mjs` — force host refusal with injected probes and assert ADMISSION_DEFERRED_EXIT is 75 and the child never starts; cross-check the generated brief against that exported constant rather than independently hard-coding its meaning.
- [A3] Explain that an ongoing owned queue command may be awaited within the existing ten-minute worker bound. Once it exits 75, hand back immediately; never sleep-loop, rerun outside the gate, turn the gate off, or report deferred as passed.
- [A4] Separate gate deferral from an executed child failure: nonzero/unknown outcomes are never green. Handback requests the orchestrator verify the lane still has the reported SHA before retrying; successful execution must report the observed result.

## Non-goals

- [N1] No new wait mechanism, changed exit codes/caps or automatic orchestrator redispatch.
- [N2] No promise that a completed exit-75 invocation can resume by polling it.

## Edge cases this change must handle

1. **Untrusted text** — Keep generated path validation; report the retry argv as data, never interpolate arbitrary output into a shell command.
2. **Truncated reads** — Place lane/SHA/command before optional prose; an incomplete handback must not be treated as executable authorization.
3. **Shared state files** — n/a: this wording change adds no shared state; the existing queue owns leases.
4. **Fail closed** — Deferral and unknown outcome are TESTS NOT RUN or FAILED/UNKNOWN, never passed.
5. **Identity scoping** — Report this worker’s lane, full SHA and exact command so siblings cannot be confused.
6. **State over time** — A pending owned action has a bounded wait; a stale handback needs a fresh head check before retry.
7. **Who wrote it** — Use tool-neutral instructions for Claude/Codex; the worker reports observed process status, not inferred success.

## Grounding

- we:scripts/worker-brief.mjs:88 prints red-green instructions and line 90 names test:unit; line 101 begins the existing bounded-wait rule.
- we:scripts/readiness/heavy-admission.mjs:217 exports ADMISSION_DEFERRED_EXIT = 75.
- we:scripts/readiness/heavy-admission.mjs:1188 immediately defers capable callers on host refusal.
- we:scripts/readiness/heavy-admission.mjs:1605 passes canDefer: true and line 1606 returns before the child execution at line 1617.
- we:scripts/__tests__/worker-brief.test.mjs:11 is the render test suite. Size 3 covers brief wording plus a cross-module subprocess/exit contract regression.
