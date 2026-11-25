---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/registry-import-timeout.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Make the check AST-based: find each dynamic import of the registry, walk to its enclosing test or… (from web-everything/web-everything#7483 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/__tests__/registry-import-timeout.test.mjs:16` — Make the check AST-based: find each dynamic import of the registry, walk to its enclosing test or hook call including modifier forms, and read that call's own timeout argument. Add self-check fixtures for it.only, it.each and a trailing hook. The description names card REGISTRY-LOAD-GUARD-HARDEN, but I found no such card in the checkout.
2. `we:scripts/operations/__tests__/registry-import-timeout.test.mjs:46` — Have the guard walk every scripts/**/__tests__ directory and match any specifier resolving to we:scripts/operations/run.mjs, then give the sites it flags explicit timeouts. File this with the guard-hardening card.
3. `we:scripts/operations/__tests__/registry-import-timeout.test.mjs:23` — Parse the test files with an AST and read the third argument of it/test calls, including .each/.only/.skip forms. Add self-check fixtures for the inner-timer and it.each cases. The PR names a card, REGISTRY-LOAD-GUARD-HARDEN, but a search of this main checkout found no such card, so confirm it is filed.
4. `we:scripts/operations/__tests__/registry-import-timeout.test.mjs:48` — Have the guard walk all scripts/**/__tests__ files and match any dynamic import specifier that resolves to we:scripts/operations/run.mjs, then add timeouts to the sites it flags. File this with the guard-hardening card.
5. `we:scripts/operations/__tests__/registry-import-timeout.test.mjs:22` — Extend the deterministic guard self-check with a nested callback timeout and a missing enclosing test timeout, asserting rejection; identify the enclosing test call's timeout structurally.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7483@e4e0efc103a76c9622c230ebe92d9dc377b293c2

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
