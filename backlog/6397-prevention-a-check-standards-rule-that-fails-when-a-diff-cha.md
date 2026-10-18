---
bornAs: xf30lsk
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/run-store.mjs", "we:scripts/operations/run-record.mjs", "we:scripts/operations/__tests__/run-store.test.mjs", "we:scripts/operations/__tests__/run-record.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — A check:standards rule that fails when a diff changes a rename or link in we:scripts/operations/r… (from web-everything/web-everything#5520 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/run-store.mjs:94` — A check:standards rule that fails when a diff changes a rename or link in `we:scripts/operations/run-store.mjs` without adding or editing a test whose name mentions it.
2. `we:scripts/operations/run-record.mjs:103` — A CLI-level test that starts review-pr with a non-prefixed `--run-id` and asserts a code-2 refusal.
3. `we:scripts/operations/run-store.mjs:94` — A check:standards rule that fails when a code comment states a guarantee ('never', 'wins', 'cannot') on a changed line with no test file in the diff touching that function. Failing that, a review lens requiring a named test for each concurrency claim.
4. `we:scripts/operations/run-store.mjs:97` — Add 'migration preserves a destination created after its existence check' to we:scripts/operations/__tests__/run-store.test.mjs, deterministically creating the competing destination before publication and asserting its contents remain unchanged.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5520@9c4629d653a3e04b24ff3e52620b9aac1b296de8

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
