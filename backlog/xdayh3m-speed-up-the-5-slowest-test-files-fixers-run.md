---
kind: story
size: 5
priority: high
status: open
scope: ["we:scripts/conveyor/__tests__/health-watch-jobs.test.mjs", "we:scripts/conveyor/__tests__/session-reaper-cli.test.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs", "we:scripts/lib/__tests__/review-loop-policy.test.mjs", "we:scripts/conveyor/__tests__/pr-stack.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Speed up the 5 slowest test files fixers run

Fixer work-time study 2026-10-10 (184 fix/ci-heal sessions since 2026-10-09): local test runs are 28% of fix active time, and the long tail is five files — we:scripts/conveyor/__tests__/health-watch-jobs.test.mjs (108 s/call, 28.7 min total), we:scripts/conveyor/__tests__/session-reaper-cli.test.mjs (117 s/call, 19.5 min), we:scripts/operations/__tests__/review-loop-cli.test.mjs (141 s/call, 16.4 min), we:scripts/lib/__tests__/review-loop-policy.test.mjs (85 s/call, 18.4 min), we:scripts/conveyor/__tests__/pr-stack.test.mjs (44 s x 35 calls, 25.5 min). Profile each, replace real subprocess/git/fs waits with injected seams or fake timers, split the slowest describe blocks, and prove per-file wall time drops (before/after numbers) with no coverage loss. Every fixer and the verify gate pay for these on every round.

Note: `we:scripts/conveyor/__tests__/health-watch-jobs.test.mjs` is not on `main` at filing time (it arrives with PR #4691); include it once that lands.

## Acceptance

- [A1] **Executable** — per-file wall time, measured with `npm run test:unit -- <file>` on an idle host, drops for each of the five files (before/after numbers in the PR), with the same test count passing.
- [A2] No test is skipped or deleted to get the speed-up.

## Non-goals

- [N1] No change to the verify gate's test selection or to the heavy-admission queue.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: test-only change.
2. **Truncated reads** — n/a: test-only change.
3. **Shared state files** — tests that touch real temp dirs keep them per-test (no shared fixture races once split).
4. **Fail closed** — a fake timer or injected seam must still let the test fail when the behaviour regresses (show one red run per changed file).
5. **Identity scoping** — n/a: test-only change.
6. **State over time** — n/a: test-only change.
7. **Who wrote it** — n/a: test-only change.
