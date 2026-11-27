---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs", "we:scripts/conveyor/pr-events-worker/worker.mjs", "we:scripts/conveyor/pr-events-worker/core.mjs", "we:scripts/conveyor/pr-events-worker/README.md", "we:scripts/conveyor/pr-events-worker/__tests__/worker.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add a table-driven occurrenceId test with one row per README claim, including the negative rows.… (from web-everything/web-everything#7557 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs:60` — Add a table-driven occurrenceId test with one row per README claim, including the negative rows. A review lens would check that every 'never' or 'requires' sentence maps to a test row.
2. `we:scripts/conveyor/pr-events-worker/worker.mjs:64` — For each config knob, add a default-path test that omits the setting and asserts the resulting behaviour.
3. `we:scripts/conveyor/pr-events-worker/worker.mjs:40` — Add a note or a size-bounded perf test for per-append storage work in the DO adapter.
4. `we:scripts/conveyor/pr-events-worker/core.mjs:345` — Add a lint or review-lens check that each declarative sentence in a slice README ("does no X", "never Y") cites a test name. Until then, add the two tests above.
5. `we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs:109` — Test "reaches no storage" claims with a `getLog` that throws, or a proxy that records every call.
6. `we:scripts/conveyor/pr-events-worker/worker.mjs:64` — Add a required adapter test using OCC_DEDUPE=off that asserts absent diagnostics and zero receipt operations.
7. `we:scripts/conveyor/pr-events-worker/core.mjs:116` — Add table-driven identity boundary tests to the required core test suite, asserting exact occurrence IDs or null and the stored missing-identity diagnostics.
8. `we:scripts/conveyor/pr-events-worker/README.md:36` — Require tests with throwing spies on hasReceipt, putReceipt, and pruneReceipts for both paths, plus assertions that every documented diagnostic field is absent.
9. `we:scripts/conveyor/pr-events-worker/core.mjs:72` — Add a required default-configuration test asserting the actual storage cutoff and capacity against independent expected values.
10. `we:scripts/conveyor/pr-events-worker/core.mjs:363` — Add a required test that replays before expiry, verifies expiry against the first arrival, and separately verifies capacity eviction against the original sequence.
11. `we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs` — Add table-driven regression tests for omitted evidence and omitted actions to the existing core test suite.
12. `we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs` — Gate the receipt suite on default-bound assertions and a replay-before-expiry regression scenario.
13. `we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs` — Add deterministic storage-call assertions for each documented no-IO boundary.
14. `we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs` — Add a deterministic late-failure rollback test comparing all affected storage state before and after failure.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7557@b52bec80af3905d93288552c53575b8b39f3bb7b

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
