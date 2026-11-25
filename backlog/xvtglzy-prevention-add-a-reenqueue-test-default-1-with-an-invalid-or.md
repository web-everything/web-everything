---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/__tests__/drain-mq-flake-reenqueue.test.mjs", "we:scripts/lib/drain-mq-flake-rerun.mjs", "we:scripts/lib/__tests__/drain-mq-flake-rerun.test.mjs", "we:scripts/lib/__tests__/drain-queue-safety.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a reenqueue test: default 1 with an invalid or ambiguous chain must still emit the token (for… (from web-everything/web-everything#7494 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-queue-safety.mjs:772` — Add a reenqueue test: default 1 with an invalid or ambiguous chain must still emit the token (for example at3=refused). Derive the emit condition from the raw failed checks, not from the validator's success output.
2. `we:scripts/lib/__tests__/drain-mq-flake-reenqueue.test.mjs:280` — Add a test that mocks readSettings to return mqEjectAfterFailures 5, 0 and '3' and asserts the effective value from readDrainQueueSafety() is 1.
3. `we:scripts/lib/drain-mq-flake-rerun.mjs:41` — Add an it.each row to 'refuses a chain with a %s member' where completed_at is earlier than started_at.
4. `we:scripts/lib/__tests__/drain-mq-flake-rerun.test.mjs:160` — Assert `a.reason` matches /operator must inspect/ in the F,S,F,S test and in the refused-member it.each table.
5. `we:scripts/lib/drain-queue-safety.mjs:771` — Gate the token on whether any raw check concluded failure and print at3=refused for refusals. Add a named test for a default-1 line over an id/time-disagreeing chain.
6. `we:scripts/lib/drain-mq-flake-rerun.mjs:39` — Add an it.each row to 'refuses a chain with a %s member' where the success has completed_at earlier than started_at. A mutation check on guard lines would catch the class.
7. `we:scripts/lib/drain-queue-safety.mjs:1185` — Add a readDrainQueueSafety test with tool values 0, 4 and '3' that asserts the effective value is 1.
8. `we:scripts/lib/drain-queue-safety.mjs:803` — Add a guard test asserting that no retry kind is returned when attempts.reason is set, to be filed with the follow-up card before the setting is raised.
9. `we:scripts/lib/__tests__/drain-mq-flake-reenqueue.test.mjs` — Add a deterministic test named 'environment 1 tightens settings 3' that asserts F,F,S holds with the override and retries without it.
10. `we:scripts/lib/drain-queue-safety.mjs:772` — Add a deterministic test in we:scripts/lib/__tests__/drain-mq-flake-reenqueue.test.mjs named 'default-1 refused chain still logs shadow' asserting that a failure with missing app metadata produces a hold or retry line containing mq-flake-shadow and at3=hold.
11. `we:scripts/lib/drain-queue-safety.mjs:772` — Add a parameterized regression gate requiring a shadow token for default-1 decisions with observed failures, including rejected chains; base token eligibility on observed failures rather than successful chain validation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7494@d49d8c0818f70969b44be7012dbaeddd3099eafe

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
