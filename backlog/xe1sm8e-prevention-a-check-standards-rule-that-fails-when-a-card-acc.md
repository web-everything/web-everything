---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/drain-mq-retry-infra-allowlist.test.mjs", "we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/__tests__/drain-mq-retry-aggregate-jobs.test.mjs", "we:scripts/lib/__tests__/drain-queue-safety.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — A check:standards rule that fails when a card Acceptance bullet has no test name in its Tests lin… (from web-everything/web-everything#7403 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/drain-mq-retry-infra-allowlist.test.mjs` — A check:standards rule that fails when a card Acceptance bullet has no test name in its Tests line.
2. `we:scripts/lib/drain-queue-safety.mjs:992` — Add a test that feeds signature and summary-text failures with full check-run timestamps and asserts exactly how many POST /rerun calls are made. Longer term, a lint requiring decision-flipping tests to assert on side-effect calls as well as the hold boolean.
3. `we:scripts/lib/__tests__/drain-mq-retry-infra-allowlist.test.mjs` — Add the named dry-run regression asserting the displayed decline reason and run it in required CI.
4. `we:scripts/lib/__tests__/drain-mq-retry-infra-allowlist.test.mjs:255` — Require acceptance-to-test mappings that identify a named consumer-level test and observable output assertion for CLI guarantees.
5. `we:scripts/lib/__tests__/drain-mq-retry-aggregate-jobs.test.mjs:211` — Assert override-dependent aggregate metadata/log reads or derived aggregate identities, and add a mutation check that bypassing environment resolution makes this named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7403@0c3a1b360d2aedffc68fd4c1b2846d7daa9aa6be

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
