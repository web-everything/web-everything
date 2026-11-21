---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-live-owner-watch-io.mjs", "we:scripts/conveyor/__tests__/pr-live-owner-watch-retry.test.mjs", "we:scripts/conveyor/__tests__/pr-live-owner-watch-io.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a table-driven test with one case per classifier path: code-only, message-only 5xx, rate limi… (from web-everything/web-everything#7270 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pr-live-owner-watch-io.mjs:67` — Add a table-driven test with one case per classifier path: code-only, message-only 5xx, rate limit, and an unrelated number. A coverage gate on new regex or Set constants would also catch the gap.
2. `we:scripts/conveyor/pr-live-owner-watch-io.mjs:67` — Add the budget-exhausted message to the at-once list in the retry test. More generally, a lint or review lens could require a test case for each named class in a guarantee comment.
3. `we:scripts/conveyor/__tests__/pr-live-owner-watch-retry.test.mjs:51` — Add deterministic fake-clock tests that charge reads, throttle waits, and sleeps against explicit and default deadlines, and assert elapsed time and whether another read starts.
4. `we:scripts/conveyor/pr-live-owner-watch-io.mjs:278` — Extend the table-driven classifier test with budget-exhaustion cases, including messages that also match the transient expression, and run it in CI.
5. `(no file cited)` — Add a named telemetry validation check that requires a complete two-hour window, records observed or injected hiccups, and asserts zero associated evidence-unavailable events.
6. `we:scripts/conveyor/pr-live-owner-watch-io.mjs:67` — Add a deterministic table-driven classifier test covering HTTP 4xx messages containing each transient keyword, with explicit assertions for any intended exceptions.
7. `we:scripts/conveyor/__tests__/pr-live-owner-watch-retry.test.mjs:51` — Extend 'the retry never exceeds the tick budget' with a controlled clock advanced by reads, throttle waits, and sleeps; assert elapsed time and retry admission for explicit and default budgets, including the health-child deadline.
8. `(no file cited)` — Add a named 'two-hour loaded watchdog single-hiccup recovery' check recording the observation interval, exercising single transient failures, and asserting zero resulting evidence-unavailable events.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7270@257afb05a55966df8754fb1f93cbe9ffb9d38ea6

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
