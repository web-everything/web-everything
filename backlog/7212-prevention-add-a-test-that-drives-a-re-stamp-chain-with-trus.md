---
bornAs: x3ryvwe
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/numbering-carry.mjs", "we:scripts/lib/accept-carry-forward.mjs", "we:scripts/lib/__tests__/numbering-carry.test.mjs", "we:scripts/lib/__tests__/accept-carry-forward.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a test that drives a re-stamp chain with trusted bot notes between the acceptance and the rec… (from web-everything/web-everything#5921 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/numbering-carry.mjs:363` — Add a test that drives a re-stamp chain with trusted bot notes between the acceptance and the record. A cheaper general guard is a lint or check:standards rule that flags `isNumberingTolerableLaterBody(x?.body)` calls that omit the comment argument.
2. `we:scripts/lib/accept-carry-forward.mjs:151` — Once every caller passes the comment, make `comment` a required argument of `isKnownMachineBody` and drop the `undefined` bypass. Back it with a test that a body-only call is false for every authored shape. Better still, add a check:standards rule forbidding `comment = undefined` defaults on author-gated predicates.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5921@31d06338a62886bce0359dfa3d7fffb19a13b8bd

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
