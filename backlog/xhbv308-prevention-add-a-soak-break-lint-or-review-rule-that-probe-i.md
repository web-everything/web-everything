---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/soak/breaks/mq-unreadable-log-single-retry.mjs", "we:scripts/lib/__tests__/drain-queue-safety-same-head-retry.test.mjs", "we:scripts/lib/drain-queue-safety.mjs", "we:scripts/conveyor/soak/breaks/__tests__/mq-unreadable-log-single-retry.test.mjs", "we:scripts/lib/__tests__/drain-queue-safety.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a soak-break lint or review rule that probe inputs must come from the real evidence producer,… (from web-everything/web-everything#7402 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/soak/breaks/mq-unreadable-log-single-retry.mjs:17` — Add a soak-break lint or review rule that probe inputs must come from the real evidence producer, or must be drawn from a closed enum shared with the producer.
2. `we:scripts/lib/__tests__/drain-queue-safety-same-head-retry.test.mjs:243` — Review lens: when a behavioural change makes a conditional unreachable, delete or rename the tests that named that condition.
3. `we:scripts/lib/__tests__/drain-queue-safety-same-head-retry.test.mjs:243` — Rename these two tests to say they check precedence of the unreadable-log hold over main-red and not-CLEAN. A lint rule that flags tests whose title names a condition the assertion text never mentions would catch this class.
4. `we:scripts/lib/__tests__/drain-queue-safety-same-head-retry.test.mjs` — Require an acceptance-to-test manifest naming discoverable test cases, with a deterministic check rejecting unmapped guarantees.
5. `we:scripts/lib/__tests__/drain-queue-safety-same-head-retry.test.mjs:105` — Require each execution-mode acceptance guarantee to map to a named test with explicit mode setup and observable output assertions, enforced through an acceptance-to-test manifest check.
6. `we:scripts/lib/__tests__/drain-queue-safety-same-head-retry.test.mjs` — Add the named dry-run integration test to the required test suite and require each Acceptance guarantee to reference its defending test.
7. `we:scripts/lib/drain-queue-safety.mjs:179` — Require Acceptance-to-test mappings and include the existing named cancelled/regroup authorization test in the required regression suite.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7402@03a565506101d863ed10f9275c1bef6efe9163fd

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
