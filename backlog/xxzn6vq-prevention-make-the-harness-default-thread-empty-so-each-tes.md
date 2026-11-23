---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/drain-merge-strategy.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Make the harness default thread empty so each test opts in to a policy-clear. Add parameterized e… (from web-everything/web-everything#7318 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/drain-merge-strategy.test.mjs:55` — Make the harness default thread empty so each test opts in to a policy-clear. Add parameterized empty-thread gate-off regressions for both kill-switch env keys and for waitForRedTeamBeforeEnqueue=false.
2. `we:scripts/lib/__tests__/drain-merge-strategy.test.mjs:1846` — Make the admission-test harness default to an empty thread and require explicit opt-in for a policy-clear. Add parameterized gate-off tests for both kill-switch env keys and for waitForRedTeamBeforeEnqueue=false, each with an explicitly empty thread, asserting enqueue succeeds. A lint that flags guard-off tests whose fixture would pass with the guard on would catch the class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7318@0fbab0d4ed18eac90c03c600af46bc83c571a93b

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
