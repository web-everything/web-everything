---
kind: story
size: 2
status: open
dateOpened: "2026-11-16"
tags: []
---

# Make verify-daemon createVerifyWakeSleep fake-timer test load-independent

Inject clock and timers so the deterministic scheduling test never depends on real sleeps.

## Acceptance

- [A1] **Executable** — `vitest run we:skills-src/conveyor/__tests__/verify-daemon.test.mjs --repeat=20` passes with zero failures under load, with the same assertions as before.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change daemon behaviour or weaken any assertion.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: test-only change.
2. **Truncated reads** — n/a: test-only change.
3. **Shared state files** — n/a: test-only change.
4. **Fail closed** — n/a: test-only change.
5. **Identity scoping** — n/a: test-only change.
6. **State over time** — n/a: test-only change.
7. **Who wrote it** — n/a: test-only change.
