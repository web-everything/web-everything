---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/__tests__/drain-mq-flake-reenqueue.test.mjs", "we:scripts/lib/__tests__/drain-mq-flake-rerun.test.mjs", "we:scripts/lib/__tests__/drain-queue-safety.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Gate on a regression test asserting that a default-1 decision includes at3=hold when observed fai… (from web-everything/web-everything#7494 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-queue-safety.mjs:772` — Gate on a regression test asserting that a default-1 decision includes at3=hold when observed failures have invalid chain ordering; determine token eligibility independently of successful chain validation.
2. `we:scripts/lib/__tests__/drain-mq-flake-reenqueue.test.mjs:279` — Add deterministic tests named 'env 1 tightens configured 3' and 'invalid env preserves configured 3', asserting the effective setting and contrasting F,F,S decisions; removing the environment binding should fail the first test.
3. `we:scripts/lib/__tests__/drain-mq-flake-rerun.test.mjs:150` — In the table-driven refusal tests, add a shared helper `expectRefused(a)` that asserts confirmed=false, candidates=[] and a non-null reason. A review lens can check that every acceptance 'refused with reason' maps to a reason assertion.
4. `we:scripts/lib/__tests__/drain-mq-flake-reenqueue.test.mjs:279` — Assert the resolved policy value (readDrainQueueSafety output) for invalid inputs instead of a downstream decision that the default also produces.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7494@73ea618f7989dad3362882dd8bdcad9366f8b09c

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
