---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/probation-build-run.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a realIo test that spies on the spawn env, plus a clip-length assertion in the heavy-admissio… (from web-everything/web-everything#4458 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/probation-build-run.mjs:791` — Add a realIo test that spies on the spawn env, plus a clip-length assertion in the heavy-admission tests. More generally, a review lens that asks for a test through each producer-to-consumer wiring point.
2. `we:scripts/readiness/heavy-admission.mjs` — Add deterministic boundary and throwing-readLease tests to the existing heavy-admission test suite, with assertions on persisted identity lengths and successful admission.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4458@9606c2ae8570385e2876dea022e39da9d92691f3

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
