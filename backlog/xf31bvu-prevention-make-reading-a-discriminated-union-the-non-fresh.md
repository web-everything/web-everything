---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci-minutes/usage.ts", "we:scripts/ci-minutes/usage.test.ts", "we:scripts/ci-minutes/__tests__/usage.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Make Reading a discriminated union: the non-fresh variants require org and cycle, and the error v… (from web-everything/web-everything#7344 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci-minutes/usage.ts:84` — Make Reading a discriminated union: the non-fresh variants require org and cycle, and the error variant of parseUsageSummary takes them as input. Add a test that a no-identity reading yields a defined result. A type-level or lint gate would catch the class, since a comment-only invariant cannot be checked.
2. `we:scripts/ci-minutes/usage.ts:85` — Add a test named 'stale warns again after a fresh reading clears it within a cycle'. Document in the card whether stale dedup is per cycle or per outage.
3. `we:scripts/ci-minutes/usage.ts:71` — Add a test for evaluateThresholds with a missing org or cycle on each state. Either emit an un-keyed warning for non-fresh feeds or document the silence explicitly.
4. `we:scripts/ci-minutes/usage.test.ts:170` — Add a helper such as readingFor(state, summary) that returns pct null for non-fresh states, and test that helper. Alternatively, drop the tautological assertion and rely on the pct:99 override test.
5. `we:scripts/ci-minutes/usage.test.ts` — Add a deterministic test named 'feed composition clears cached pct on stale or failed feeds' at the composition boundary, supplying a numeric cached percentage and asserting the returned pct is null for both states.
6. `we:scripts/ci-minutes/usage.test.ts` — Add a deterministic test of production reading composition using a cached numeric percentage and stale/error feed inputs, asserting the resulting pct is null.
7. `we:scripts/ci-minutes/usage.ts:78` — Add a parameterized test for absent org, absent cycle, and malformed cycle, asserting empty notification lines and unchanged fired keys; include guard deletion in mutation testing.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7344@0f4aa74cc57776885b91cb4be276353c490b9fe3

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
