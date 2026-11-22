---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci-minutes/usage.ts", "we:scripts/ci-minutes/usage.test.ts", "we:scripts/ci-minutes/__tests__/usage.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a branch-coverage threshold for scripts/ci-minutes/*.ts. Failing that, add a review-lens chec… (from web-everything/web-everything#7344 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci-minutes/usage.ts:79` — Add a branch-coverage threshold for scripts/ci-minutes/*.ts. Failing that, add a review-lens checklist item: every early return in a pure function gets one named test.
2. `we:scripts/ci-minutes/usage.ts:91` — For each fail-closed guard, require a table-driven test that enumerates every disjunct of the condition. A review lens can enforce this.
3. `we:scripts/ci-minutes/usage.ts:79` — Have the S2.1 caller card include a test that a parse failure still produces one warning per cycle. Alternatively, add an optional org/cycle fallback to the Reading builder.
4. `we:scripts/ci-minutes/usage.ts:84` — Make Reading a discriminated union that requires org and cycle, or have evaluateThresholds return an explicit 'unattributable' line instead of an empty result. Add a composition test, `parseUsageSummary` error into `evaluateThresholds`, to the S2 wiring.
5. `we:scripts/ci-minutes/usage.test.ts:173` — Add a coverage threshold on scripts/ci-minutes, or a branch-coverage gate in check:standards for guard-style early returns. Add table-driven tests for invalid identity, pct and includedMinutes.
6. `we:scripts/ci-minutes/usage.test.ts` — Add a production-composition contract test and a targeted mutation gate that retains cached pct on stale/error feeds.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7344@a63345e72270661526b543b2687167fa2cd38b1a

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
