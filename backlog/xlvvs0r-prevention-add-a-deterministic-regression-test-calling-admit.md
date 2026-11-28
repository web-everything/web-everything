---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/ci-heal-admission.mjs", "we:scripts/conveyor/__tests__/reconcile-core-ci-heal-admission.test.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/ci-heal-admission.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a deterministic regression test calling admitCiHeal with a main-class hold and no mainState p… (from web-everything/web-everything#7531 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/ci-heal-admission.mjs:4` — Add a deterministic regression test calling admitCiHeal with a main-class hold and no mainState property, asserting main-red refusal.
2. `we:scripts/conveyor/__tests__/reconcile-core-ci-heal-admission.test.mjs:31` — Add deterministic logging assertions for both push sites and named live-read and 24-hour oracle checks; require Acceptance entries to reference registered tests or concrete planned checks.
3. `we:scripts/conveyor/reconcile-core.mjs:3270` — Route admission logging through an injectable logger or a returned field on the plan, so a test can assert it. Or add a lint that requires an Acceptance bullet to name a test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7531@f7ff717175facb12568f632d327977f7a9914f2d

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
