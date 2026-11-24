---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/delivery/delivery-read.test.ts", "we:src/delivery/delivery-read.ts", "we:src/delivery/__tests__/delivery-read.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Run Stryker or a similar mutation check on we:src/delivery/delivery-read.ts in verify-lane. Alternatively… (from plateauapp/plateau-app#233 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/delivery/delivery-read.test.ts:117` — Run Stryker or a similar mutation check on `we:src/delivery/delivery-read.ts` in verify-lane. Alternatively, generate a negative case from each clause of the validator.
2. `we:src/delivery/delivery-read.test.ts:186` — Change the AST import test into an exact allowlist assertion on import specifiers, and add an assertion that the identifier `fetch` and named write imports from node:fs are absent. Lint rules such as no-restricted-imports for the src/delivery directory would also work.
3. `we:src/delivery/delivery-read.ts:47` — Add a deterministic parameterized contract test covering envelope and populated raw-array inputs with identical output assertions.
4. `we:src/delivery/delivery-read.ts:47` — Add a parameterized contract test for envelope and nonempty raw-array inputs to the required delivery-read test command.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#233@5a0c3ce7bef3986d7994c2d99df091c053e94b5b

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
