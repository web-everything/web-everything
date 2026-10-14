---
bornAs: x0dcjec
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/worker-wrapper-launch.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Daemon rebuild smoke launches a real Claude session (fix dry-run is wrapped)

HIGH. The daemon rebuild live smoke's fix dispatch dry-run starts a REAL detached claude -p session (fix-900002, fake PR 900002): 332 sessions since 2026-10-13 (225 on 10-13, 107 on 10-14), avg 32 s, 131k cache-write + 368k cache-read tokens each, about $0.6 each, about $200 in two days. Cause: we:scripts/lib/daemon-live-smoke.mjs (around :552-560) injects spawnAgent but not wrapFix:false; dispatchFix defaults wrapFix = workerWrapperEnabledFor('fix') (we:scripts/conveyor/reconcile-fix-dispatch.mjs:1330), true because 'fix' is in WRAPPED_ROLES_DEFAULT_ON (we:scripts/operations/worker-wrapper-launch.mjs:38); the test-isolation guard does not apply outside tests, so launchWrapped starts the real worker. The stub is never called, captured stays null, and checkFilled(null) passes on the empty string (we:scripts/lib/daemon-live-smoke.mjs:520), so the fix brief check has tested nothing since wrapping became the default. Review has the same latent gap (we:scripts/operations/review-dispatch.mjs:580,644), not firing today. Fix: set WE_WORKER_WRAPPER=off in the dry-run child's env (around :645), or inject wrapFix:false and wrapReview:false; make checkFilled fail on a null or empty prompt; add a guard test that the dry-run child never reaches launchWrappedClaudeWorker. Keep a cascade setting that can allow a real worker deliberately. Prove: one rebuild smoke with zero real claude processes, and smoke time before/after.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/daemon-live-smoke.test.mjs`: a new test asserts the fix (and review) dry-run child env carries `WE_WORKER_WRAPPER=off` and that `checkFilled` throws on a null or empty prompt; it fails before and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the deliberate real-worker overlay smoke (`ci-heal-999998` in we:scripts/lib/daemon-load-overlay.mjs); that is a separate cost item.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no external text is parsed; the change is an env flag and a null check.
2. **Truncated reads** — a null or empty captured prompt now FAILS the check instead of passing.
3. **Shared state files** — n/a: no shared state file is written.
4. **Fail closed** — if the wrapper flag cannot be set, the smoke fails rather than starting a real session.
5. **Identity scoping** — applies only to the smoke dry-run child (sentinel PR numbers 9xxxxx), never to real dispatch.
6. **State over time** — a guard test keeps a future default-on wrapper role from silently re-opening the hole.
7. **Who wrote it** — n/a: no authored records are read.
