---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/pr-sweep-core.mjs", "we:scripts/operations/__tests__/pr-sweep-core.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — A table-driven test that iterates every key of DRAIN_SKIP_ACTOR through assessPrSweep. It should… (from web-everything/web-everything#7295 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/pr-sweep-core.mjs:221` — A table-driven test that iterates every key of `DRAIN_SKIP_ACTOR` through `assessPrSweep`. It should assert that `EXPECTED_ACTOR['drain-skip:'+kind]` equals the resulting actor, so the sweep map and the classifier map cannot drift. Better as a `check:standards` cross-map consistency rule.
2. `we:scripts/operations/pr-sweep-core.mjs:221` — Add an integration test that runs assessPrSweep and then classifyStall for each EXPECTED_ACTOR drain-skip key. A check:standards rule could also assert that every `drain-skip:*` key in EXPECTED_ACTOR has a matching DRAIN_SKIP_ACTOR entry. That would catch this whole class of producer/consumer mapping drift.
3. `we:scripts/operations/pr-sweep-core.mjs:221` — Add a parameterized integration test in we:scripts/operations/__tests__/pr-sweep.test.mjs that produces both drain-skip rows, asserts their actors, and passes them to classifyStall; run it in the existing test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7295@044b54f99996a32ac399ae42269fd543cc22599f

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
