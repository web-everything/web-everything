---
bornAs: xumjnv8
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/perf-velocity.mjs", "we:scripts/operations/perf-snapshot-io.mjs", "we:scripts/operations/perf-velocity-io.mjs", "we:scripts/operations/__tests__/perf-velocity-io.test.mjs", "we:scripts/operations/__tests__/perf-velocity.test.mjs", "we:scripts/operations/__tests__/perf-snapshot-io.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — For each edge case the card lists, require a named test whose title cites the edge-case number an… (from web-everything/web-everything#4370 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/perf-velocity.mjs:147` — For each edge case the card lists, require a named test whose title cites the edge-case number and which fails when the guarding line is removed. A mutation-check lens in review would do this; a script gate is hard here.
2. `we:scripts/operations/perf-snapshot-io.mjs:225` — Give the sink an injectable `collectVelocity` seam and add one failure-path test. A review-lens checklist item "every fail-closed claim has a failure-injection test" would also catch this class.
3. `we:scripts/operations/perf-velocity-io.mjs:138` — Add a lint or test helper convention: validate model output with an explicit allowlist (FIBONACCI.includes(Number.isInteger(x) ? x : NaN)) before any snapping. Add a table-driven test for estimateOne with null, 0, '', 'abc' and 4.4.
4. `we:scripts/operations/__tests__/perf-velocity-io.test.mjs:66` — Review lens or checklist step: every 'Edge cases this change must handle' bullet maps to a named test. Cheapest guard is a test asserting buildBrief output length is under the cap for a 100k body, plus a sink-level test with a git failure injected.
5. `we:scripts/operations/__tests__/perf-velocity-io.test.mjs` — Add a deterministic test named 'omits velocity and preserves unrelated metrics when history reading fails' in we:scripts/operations/__tests__/perf-velocity-io.test.mjs; force a history-read error and assert no velocity keys, an unavailable note, and retained unrelated metrics.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4370@e1dd3da199b7da2955be1e7f8f5f59ef818e6c17

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
