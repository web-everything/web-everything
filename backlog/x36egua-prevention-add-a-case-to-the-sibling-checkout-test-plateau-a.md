---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verify-lane-gate.mjs", "we:scripts/lib/__tests__/verify-lane-gate.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a case to the sibling-checkout test: plateau-app origin with no fileExists expects FALLBACK_G… (from web-everything/web-everything#7461 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verify-lane-gate.mjs:520` — Add a case to the sibling-checkout test: plateau-app origin with no fileExists expects FALLBACK_GATE. More generally, a mutation check over changed conditionals would catch this class.
2. `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:126` — Add a case with a frontierui origin and fileExists returning true that expects FALLBACK_GATE. Cover each term of a compound gate condition with its own fixture.
3. `we:scripts/lib/verify-lane-gate.mjs:454` — Give the repo profile a standards-command field covering every registered repo, including pending ones, with a test that iterates them all. The PR mentions a reinforce-later card for the profile field; I did not verify that it exists or covers longshore.
4. `we:scripts/lib/verify-lane-gate.mjs:520` — Add a case to we:scripts/lib/__tests__/verify-lane-gate.test.mjs with a plateau-app origin and no `fileExists`, asserting `command` equals FALLBACK_GATE. A mutation check on changed guard conditions would catch the class.
5. `we:scripts/lib/verify-lane-gate.mjs:520` — Add a case with a frontierui origin and `fileExists: () => true`, asserting `command` equals FALLBACK_GATE and `decision.standards.run` is true.
6. `we:scripts/lib/verify-lane-gate.mjs:520` — Declare each repo's standards command in the repo profile (the reinforce-later card the PR mentions), or fail closed when the diff's deleted files include the validator.
7. `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:126` — Add the two named regression tests to the existing test gate, asserting the exact fallback command and a meaningful skip reason in both diagnostic fields.
8. `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:126` — Add the two named regression tests to the existing test gate, asserting FALLBACK_GATE without fileExists and an explanatory decision.standards.reason when skipping.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7461@53352d0047fd136cda04889204e9bce659f2bb84

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
