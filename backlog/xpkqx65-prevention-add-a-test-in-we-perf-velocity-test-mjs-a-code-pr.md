---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/perf-velocity.mjs", "we:scripts/operations/perf-snapshot-io.mjs", "we:scripts/operations/perf-velocity-io.mjs", "we:scripts/operations/__tests__/perf-velocity-io.test.mjs", "we:scripts/operations/__tests__/perf-velocity.test.mjs", "we:scripts/operations/__tests__/perf-snapshot-io.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a test in we:perf-velocity.test.mjs: a code PR touching only an open sized card must NOT be c… (from web-everything/web-everything#4370 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/perf-velocity.mjs:163` — Add a test in we:perf-velocity.test.mjs: a code PR touching only an open sized card must NOT be covered. Better still, derive `covered` from the resolve events (ids resolved at or after the PR's merge) instead of the size field.
2. `we:scripts/operations/perf-snapshot-io.mjs:207` — Give createPerfSnapshotSinks a `velocity` seam (default real, tests inject a stub or a throwing reader), and add a named test for the 'velocity unavailable' note. A lint or standards rule against real `git fetch` in unit tests would cover the wider class.
3. `we:scripts/operations/perf-velocity-io.mjs:118` — Validate with a strict predicate before snapping: Number.isInteger(raw) && raw > 0, otherwise throw. Add a table-driven test of bad model outputs (null, '', 0, -1, 'abc', missing) that must all leave the PR unestimated.
4. `we:scripts/operations/perf-velocity-io.mjs:110` — Bound untrusted input before any regex: slice to a hard maximum first, then strip. A review-lens note on 'regex over unbounded external text' would catch the class; a lint rule for it is hard to write.
5. `we:scripts/operations/__tests__/perf-velocity-io.test.mjs:1` — Give each edge case in a card's 'Edge cases this change must handle' list a named test, and have a check:standards rule reject a card whose edge-case count has no matching test-name references.
6. `we:scripts/operations/perf-velocity.mjs:217` — Add deterministic DST boundary cases to the ET calendar-day test and calculate yesterday by decrementing the ET calendar date rather than subtracting 24 elapsed hours.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4370@8f74ca569d732a37315b240e046ad035ff5f29c7

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
