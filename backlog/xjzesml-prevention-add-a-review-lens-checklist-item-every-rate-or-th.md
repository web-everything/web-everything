---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/__tests__/prepare-failure-policy.test.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a review-lens checklist item: every rate or throttle claim in a PR description needs a named… (from web-everything/web-everything#7509 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:1487` — Add a review-lens checklist item: every rate or throttle claim in a PR description needs a named test that fakes the clock. A deterministic gate is hard here; this is a lens item.
2. `we:skills-src/conveyor/build-dispatch-daemon.mjs:1488` — Add a vitest case that calls `runBuildDispatchTick` twice at cap 0 with an injected `effects.now`, and spies on `console.error`. Longer term, a review lens or lint rule that flags a prose claim of rate-limited logging with no test referencing the interval.
3. `we:skills-src/conveyor/build-dispatch-daemon.mjs:1488` — Add a deterministic fake-clock test asserting the initial log, suppression within the hour, and another log when the hour elapses.
4. `we:scripts/conveyor/__tests__/prepare-failure-policy.test.mjs:597` — Extend the named test with two terminal JSON records containing distinct details and assert that only the later detail is returned.
5. `we:scripts/conveyor/__tests__/prepare-failure-policy.test.mjs:609` — Add deterministic parameterized cases that invalidate outcome and detail separately, keep the other field valid, and assert evidence.error is null.
6. `we:skills-src/conveyor/build-dispatch-daemon.mjs:1488` — Add a deterministic fake-clock test that spies on console.error across repeated ticks and gates the hourly logging behavior in CI.
7. `we:scripts/conveyor/__tests__/prepare-failure-policy.test.mjs:610` — Add parameterized CI cases with each required field independently set to non-string values, asserting evidence.error remains null.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7509@5a19bf00685361e5b957acdf4dcfac3738d4b852

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
