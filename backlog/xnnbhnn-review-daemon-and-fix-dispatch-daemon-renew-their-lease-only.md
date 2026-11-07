---
kind: story
size: 5
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:skills-src/conveyor/runner-lock.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:skills-src/conveyor/pass-daemon.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# review-daemon and fix-dispatch daemon renew their lease only between ticks, with no timer and no tick budget …

Flow-sim gap R8c-G2, class K7 (unserialized duplicate actors). Failing input: Resident review-daemon (lease key '<conveyor:review-daemon-lease>', 15 min via RUNNER_LEASE_MINUTES) or reconcile-fix-dispatch daemon (key '<conveyor:reconcile-fix-dispatch-daemon-lease>') in the middle of one tick. Tick interval is 120 s (we:review-daemon.mjs:148) but a tick has no wall-clock bound (grep for deadline/budget/se… Cited: we:skills-src/conveyor/review-daemon.mjs:174-190, we:skills-src/conveyor/review-daemon.mjs:1741, we:skills-src/conveyor/runner-lock.mjs, we:skills-src/conveyor/review-daemon.mjs:1813, we:skills-src/conveyor/review-daemon.mjs:186-187. Soak-break sketch: Fixture: runDaemonLoop with a tickOnce that advances an injected clock 16 min and, mid-tick, a second acquireRunnerLease on the same key. Assertion that fails today: the first loop must not dispatch after the lease is lost (a dispatch effect called after the …

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
