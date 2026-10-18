---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/__tests__/build-dispatch-non-blocking-launch.test.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Add a lifecycle test for clear-on-delivery. Optionally add a lint that flags unused optional test… (from web-everything/web-everything#5453 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/__tests__/build-dispatch-non-blocking-launch.test.mjs:160` — Add a lifecycle test for clear-on-delivery. Optionally add a lint that flags unused optional test-helper params.
2. `we:skills-src/conveyor/build-dispatch-daemon.mjs:875` — Record the lookup-unavailable case as a non-charged observation, for example by adding the reason to the clone-wide codes. Add a daemon test that a git failure writes no persisted attempt.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5453@7e169d308d4ce9f23897e6ff6a640730edf0e07d

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
