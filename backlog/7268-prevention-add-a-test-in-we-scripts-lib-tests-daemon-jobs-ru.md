---
bornAs: x1mwqk2
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-jobs-runtime.mjs", "we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Prevention — Add a test in we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs for a non-expired foreign-han… (from web-everything/web-everything#5966 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-jobs-runtime.mjs:470` — Add a test in we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs for a non-expired foreign-handle task record that asserts no `stop-failed` action. Review-lens note only.
2. `we:scripts/lib/daemon-jobs-runtime.mjs:455` — Add a test with one task record that has an invalid `launchedAt`. It should assert the other records are still processed and that the bad one is logged as corrupt or left untouched.
3. `we:scripts/lib/daemon-jobs-runtime.mjs:432` — Make `releaseTaskClaim` default to a function that throws when the store holds any task record. Alternatively, add a daemon-wiring test that asserts the production `reattachTick` call passes a release port. Part 4 could carry this.
4. `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs` — Extend this named regression test with an attempt-2 effect spy and an explicit zero-replay assertion, enforced by the test suite.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5966@5fb2da632261243b382a3f6c5ace882f137e9e35

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
