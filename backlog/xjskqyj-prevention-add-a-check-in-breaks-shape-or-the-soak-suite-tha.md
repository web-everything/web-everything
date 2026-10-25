---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/soak/breaks/hung-ci-cancel-run-not-found-loops.mjs", "we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/hung-ci-cancel-run-not-found-loops.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a check in breaks-shape or the soak suite that fixPresent returns false against the break's p… (from web-everything/web-everything#5883 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/soak/breaks/hung-ci-cancel-run-not-found-loops.mjs:27` — Add a check in breaks-shape or the soak suite that fixPresent returns false against the break's pre-fix tree. Run it with the fix's production lines reverted, or against a pinned pre-fix fixture.
2. `we:scripts/conveyor/ci-red-recovery-watch.mjs:952` — Review lens: for every guard in a sweep branch, require a test of the sibling outcome that the guard excludes.
3. `we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs:693` — Add a deterministic regression test using the default trigger with lower-level IO stubbed; assert the expected-head preflight occurs and a moved head prevents the push.
4. `we:scripts/conveyor/ci-red-recovery-watch.mjs:958` — Add a deterministic integration test exercising the default trigger after a cancel 404, with a changed remote head, and assert that no push occurs.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5883@5eb92b1825b646e261dedcfc754b7f09a446e18c

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
