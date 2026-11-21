---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/drain-classify-only.test.mjs", "we:scripts/drain-classify-only.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — For any new .every/.some guard, require a mixed-input case as the failing-closed test. This could… (from web-everything/web-everything#7260 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/drain-classify-only.test.mjs:62` — For any new `.every`/`.some` guard, require a mixed-input case as the failing-closed test. This could go in the review checklist for fail-closed degradations; a deterministic gate is impractical.
2. `we:scripts/drain-classify-only.mjs:178` — Add a branch-coverage threshold for scripts/drain-*.mjs in vitest, so an untested `catch` is flagged. Failing that, add a standing review-lens item: every `catch` that falls through to a failure path needs a throwing-mock test.
3. `we:scripts/drain-classify-only.mjs:178` — Add the named throwing-write regression test to the automated test gate.
4. `we:scripts/drain-classify-only.mjs:26` — Add a deterministic parameterized test requiring missing and non-listing kind values to produce a hard failure in a mixed batch, and require kind === 'listing' in the predicate.
5. `we:scripts/__tests__/drain-classify-only.test.mjs` — Add a named workflow smoke check that records the dispatched run and asserts its final conclusion, and require acceptance items to reference named checks.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7260@d826c6d8de357483f4369b21513c0e59f3930ad9

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
