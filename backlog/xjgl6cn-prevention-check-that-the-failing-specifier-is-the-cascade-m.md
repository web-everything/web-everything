---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/forge-slots.mjs", "we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs", "we:scripts/readiness/__tests__/forge-slots.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Check that the failing specifier is the cascade module itself, for example by testing error.messa… (from web-everything/web-everything#7267 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/forge-slots.mjs:40` — Check that the failing specifier is the cascade module itself, for example by testing error.message with a pattern anchored on the resolved cascade path before 'imported from'. Add a test with a copied we:scripts/readiness/forge-slots.mjs and no cascade module, plus one with a broken transitive import.
2. `we:scripts/readiness/forge-slots.mjs:43` — Match the resolved specifier exactly, for example by checking that error.url or the 'Cannot find module' path ends with we:lib/policy-cascade.mjs. Add a test that places a broken import under a stub cascade and expects exit 1. A lint rule against bare `message.includes` for error classification would catch the class.
3. `we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs:1` — Add a coverage-gate check that every `catch` or early-return branch in a new reader has a named test. Failing that, require the card's Test plan to map each Risk to a named test case.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7267@fcdec4c9fce5461198b8f94f9c3fc9cafc6f23e3

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
