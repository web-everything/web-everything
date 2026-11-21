---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/check-scope.mjs", "we:scripts/operations/run.mjs", "we:scripts/operations/__tests__/check-scope.test.mjs", "we:scripts/operations/__tests__/run.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Reject empty or whitespace-only declared files before the prose filter. Add a test for empty and… (from web-everything/web-everything#7256 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/check-scope.mjs:18` — Reject empty or whitespace-only declared files before the prose filter. Add a test for empty and missing `--files`. Where an op's input is semantically required, a lint could flag declarations that leave it optional.
2. `we:scripts/operations/run.mjs:630` — Require each acceptance guarantee to name a test at the layer where it is made. A card-to-test mapping check in the PR template or gate would catch this. Add an operations-runner test helper that executes an op end to end with injected sinks.
3. `we:scripts/operations/check-scope.mjs:18` — Reject an empty declared list as unknown (exit 2) before the prose filter, and add a named test for `declaredFiles: ''`, `[]` and `','`. Longer term, a standards rule that requires an empty-input test for fail-closed admission functions.
4. `we:scripts/operations/run.mjs:630` — A check:standards rule that every prose guarantee ('exit N') in a PR description or card maps to a named test. Cheaper: move the verdict-to-exit-code mapping into we:scripts/operations/check-scope.mjs as an exported function and unit-test it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7256@f5f19c19ba3c1b73cc5e085c1fecfeaff7064c8d

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
