---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci/rerun-failed-once.mjs", "we:scripts/ci/__tests__/rerun-failed-once.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a contract test that generates a real Vitest JSON report (one failing test, one collection er… (from web-everything/web-everything#7366 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci/rerun-failed-once.mjs:96` — Add a contract test that generates a real Vitest JSON report (one failing test, one collection error) and runs it through parseReport/planRetry. A check:standards rule could also require a CI-evidence parser to have at least one fixture produced by the real tool.
2. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:93` — Add table-driven tests over each clause of the identity check and the aggregate-count check. Mutation-test the guard lines in CI.
3. `we:scripts/ci/rerun-failed-once.mjs:131` — Add a gate that every early-return refusal branch in rerunOnce has a test, for example a branch-coverage threshold on this file. Until then, add a `teardownFailed: () => true` refusal test.
4. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:78` — Test-plan template rule that a compound guard needs one test per operand. A mutation-testing step on scripts/ci/*.mjs would enforce it.
5. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:115` — Branch-coverage threshold on we:scripts/ci/rerun-failed-once.mjs (deterministic gate), plus a table-driven test over each evidence-refusal branch.
6. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:1` — Card-template check that each Acceptance bullet names a test file and case. A hash-pin test on we:policy-cascade.mjs would serve for the 'unchanged' claim.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7366@248b9b9a2757887280cb826d6cebe55c1d7ad551

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
