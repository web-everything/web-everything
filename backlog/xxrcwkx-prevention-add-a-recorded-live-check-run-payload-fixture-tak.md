---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/__tests__/drain-queue-safety-same-head-retry.test.mjs", "we:scripts/conveyor/soak/breaks/mq-unreadable-log-single-retry.mjs", "we:scripts/lib/__tests__/drain-queue-safety.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/mq-unreadable-log-single-retry.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a recorded live check-run payload fixture, taken from #7284's failed job, as a contract test… (from web-everything/web-everything#7305 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-queue-safety.mjs:968` — Add a recorded live check-run payload fixture, taken from #7284's failed job, as a contract test for the unreadable-log path. A lint or gate for this would be hard to write, so a recorded fixture is the cheapest guard.
2. `we:scripts/lib/drain-queue-safety.mjs:963` — Add a fixture that exhausts the retry-evidence budget before the first job-log read. Assert hold and the absence of the `unreadable-log retry` line. A write-gate that requires a test for each moved or edited fail-closed guard would catch this class.
3. `we:scripts/lib/__tests__/drain-queue-safety-same-head-retry.test.mjs:115` — Parameterize the assertion-output regression test across title, summary, and text, requiring a hold for every field.
4. `we:scripts/conveyor/soak/breaks/mq-unreadable-log-single-retry.mjs:18` — Add a named post-load smoke check that asserts the loaded revision, first retry, and subsequent hold, and records the successor outcome.
5. `we:scripts/lib/drain-queue-safety.mjs:969` — Add a deterministic parameterized regression test covering assertion evidence independently in title, summary, and text.
6. `(no file cited)` — Require each Acceptance item to reference a named automated test or, for a live operational outcome, a recorded verification with observable results.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7305@9118cfc61d2b223303ac497b49b4acf9ab0b7b1f

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
