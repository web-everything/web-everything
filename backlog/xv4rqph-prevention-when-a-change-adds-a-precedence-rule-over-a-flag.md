---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/dispatch-eligibility-shadow.test.mjs", "we:scripts/conveyor/dispatch-eligibility-shadow.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — When a change adds a precedence rule over a flag, add a table-driven test that covers every flag… (from web-everything/web-everything#7432 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/dispatch-eligibility-shadow.test.mjs` — When a change adds a precedence rule over a flag, add a table-driven test that covers every flag value (true, false, unset) at every length bucket (below cap, at cap, above cap). This can go in the `dlv:SHADOW-ELIG-HARDEN` card.
2. `we:scripts/conveyor/dispatch-eligibility-shadow.mjs:93` — Add a frozen-input case to the shadow observational-contract tests. More generally, use a lint or test helper that deep-freezes fixtures passed to record-only shadow runners.
3. `we:scripts/conveyor/__tests__/dispatch-eligibility-shadow.test.mjs:98` — For each tri-state input, require a table-driven test that covers every branch (true, false, unset, malformed) at both sides of the cap. This could be enforced as a review-lens checklist item.
4. `(no file cited)` — Add an acceptance-template gate requiring a named implemented or planned verification for each behavioral guarantee.
5. `we:scripts/conveyor/dispatch-eligibility-shadow.mjs:7` — Add a parameterized explicit-true regression at and above the cap, and a targeted mutation check removing the true override.
6. `we:scripts/conveyor/dispatch-eligibility-shadow.mjs:92` — Add an input-preservation regression using a frozen PR and an unchanged-input assertion, with a targeted mutation replacing the copy with in-place normalization.
7. `we:scripts/conveyor/dispatch-eligibility-shadow.mjs:8` — Add the two named regression tests and require them in the existing test gate.
8. `(no file cited)` — Add a named shadow-log verification check asserting the below-cap thread-reason reduction, preserved cap/explicit-false behavior, and unchanged unrelated disagreement reasons, with a scheduled seven-day invocation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7432@e378084560fb03009497b43c1c24cc100a5f98ef

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
