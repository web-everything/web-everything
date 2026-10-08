---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/perf-snapshot-io.mjs", "we:scripts/operations/perf-velocity-io.mjs", "we:scripts/operations/perf-velocity.mjs", "we:scripts/operations/__tests__/perf-snapshot-io.test.mjs", "we:scripts/operations/__tests__/perf-velocity-io.test.mjs", "we:scripts/operations/__tests__/perf-velocity.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Give createPerfSnapshotSinks an injectable velocity collector, and add a standards or lint rule t… (from web-everything/web-everything#4370 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/perf-snapshot-io.mjs:205` — Give `createPerfSnapshotSinks` an injectable velocity collector, and add a standards or lint rule that sink tests may not call `git fetch` (or other network-reaching process calls) unstubbed.
2. `we:scripts/operations/perf-velocity-io.mjs:69` — Review lens: every stated 'ignored/skipped' guard needs a test with a row that should be rejected.
3. `we:scripts/operations/perf-velocity.mjs:139` — Add a replay test over a fixed git fixture asserting that every code PR is counted in exactly one of real, estimated or an explicit 'pending' bucket.
4. `we:scripts/operations/perf-snapshot-io.mjs:208` — Add a card write-gate or lint that requires each 'Edge cases this change must handle' bullet to map to a named test, or a `check:standards` rule that fails when a sink `try/catch` fail-closed branch has no covering test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4370@2c3f0bd5f8e8617407c86b38f9f5f40239479393

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
