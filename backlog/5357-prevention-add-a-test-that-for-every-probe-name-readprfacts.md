---
bornAs: xjak297
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/review-ledger-check.mjs", "we:scripts/conveyor/pr-label-mirror.mjs", "we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs", "we:scripts/__tests__/review-ledger-check.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a test that, for every probe name readPrFacts can emit, passes it through deriveRow and asser… (from web-everything/web-everything#4407 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/review-ledger-check.mjs:222` — Add a test that, for every probe name readPrFacts can emit, passes it through deriveRow and asserts the row is unreadable (or the plan is empty) when the label-relevant probes failed. Better, make readPrFacts expose a structured `labelRelevantUnavailable` flag so consumers need no regex.
2. `we:scripts/conveyor/pr-label-mirror.mjs:65` — Share a flag parser that rejects boolean values for numeric flags.
3. `we:scripts/review-ledger-check.mjs:205` — Make deriveRow treat any non-empty facts.probeErrors as unreadable, or export an explicit allowlist of tolerable probe errors from pr-state-io. Add a table-driven test that feeds each errors.push string from pr-state-io and asserts the status.
4. `we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs:47` — Add a deterministic integration test that executes the default report dependency chain with fixture-backed reads and fails on any GitHub mutation or persistent filesystem write; retain stdout as an allowed output.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4407@8ebe1d12318af4f3b6787e8ef14079fa7e08f18e

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
