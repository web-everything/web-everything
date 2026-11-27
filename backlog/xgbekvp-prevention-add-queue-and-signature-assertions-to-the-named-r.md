---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/main-ci-red-core.mjs", "we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs", "we:scripts/conveyor/main-red-metrics-journal.mjs", "we:scripts/conveyor/__tests__/main-red-metrics-journal.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add queue and signature assertions to the named regression test, and restrict the rejection to ep… (from web-everything/web-everything#7606 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/main-ci-red-core.mjs` — Add queue and signature assertions to the named regression test, and restrict the rejection to episode-duration updates.
2. `we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs` — Add a required Vitest case that first asserts the oversized fixture passes validMainRedMetric, then verifies report rejection at the byte boundary.
3. `we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs` — Parameterize the required retention test across null, before-from, exactly-from and after-from recovery times, asserting queue inclusion for each.
4. `we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs` — Add the named ISO-input regression case to the required main-ci-red-core Vitest suite.
5. `we:scripts/conveyor/main-red-metrics-journal.mjs:9` — Add a named case 'refuses a scan limit above the 10,000-file ceiling' that asserts appendMainRedMetrics(dir, [e], { limit: 10_001 }).warnings equals [metricRecovery] and that writeFile is not called, with the same assertion for the reader. More generally, a lens rule: every caller-overridable bound option needs a test with a value above the bound.
6. `we:scripts/conveyor/main-red-metrics-journal.mjs:59` — Add an EEXIST winner fixture that matches every transition field but carries an extra property (e.g. `{ ...event, extra: 1 }`) and assert the recovery warning. More generally, a review lens: for each compound guard in a refusal path, there should be at least one fixture that only that operand catches.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7606@75fa4f6cfdc86e28175318fc121e6e7b3012d5e6

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
