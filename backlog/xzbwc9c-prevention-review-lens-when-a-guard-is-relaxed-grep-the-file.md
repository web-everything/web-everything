---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-seat-runner.mjs", "we:scripts/operations/__tests__/review-seat-runner.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Review lens: when a guard is relaxed, grep the file for prose that describes the old guard. No de… (from web-everything/web-everything#7255 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-seat-runner.mjs:55` — Review lens: when a guard is relaxed, grep the file for prose that describes the old guard. No deterministic gate is practical.
2. `we:scripts/operations/review-seat-runner.mjs:31` — Run prettier or the repo's format check as a pre-commit gate. The existing check:standards style rules should catch a missing space around `=`.
3. `we:scripts/operations/__tests__/review-seat-runner.test.mjs:728` — Add a runner-level test table for the Carbon switch (unset, blank, 'x', '0', '5') with the live cap at 0. Where review-seat-caps defaults are changed, require a test per branch.
4. `we:scripts/operations/review-seat-runner.mjs:54` — A review lens check that comments mentioning a changed constant or cap are re-read when that cap logic changes. No deterministic gate is practical.
5. `(no file cited)` — Add a deterministic preparation-card check requiring every acceptance item to reference a named automated test or planned operational check with an observable assertion.
6. `(no file cited)` — Add a planned named check, carbon_shadow_emits_ok_within_two_hours, that asserts the model, status, and timestamp of a persisted daemon row after prototype-load.
7. `(no file cited)` — Identify or add named tests shadow_does_not_delay_primary_review and shadow_verdict_does_not_affect_labels_or_gates; use a pending shadow promise for the first and conflicting primary/shadow verdicts with label and gate assertions for the second.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7255@be36ebd6757a45235bb27de2237a0d78430dcad3

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
