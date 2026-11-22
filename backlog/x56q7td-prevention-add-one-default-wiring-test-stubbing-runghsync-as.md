---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/promote-draft-pr-dispatch.mjs", "we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add one default-wiring test, stubbing runGhSync as the existing cross-repo test does, that assert… (from web-everything/web-everything#7296 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/promote-draft-pr-dispatch.mjs:283` — Add one default-wiring test, stubbing `runGhSync` as the existing cross-repo test does, that asserts `ready` is not called when the real reader returns a park comment.
2. `(no file cited)` — Add an acceptance-to-test mapping gate requiring each acceptance item to identify a named automated test or a concrete operational verification with observable assertions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7296@680a039880bfba7f1004ff7bc8f47d2ae00552d8

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
