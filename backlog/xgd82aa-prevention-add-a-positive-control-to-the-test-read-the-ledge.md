---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/resource-pool-io.test.mjs", "we:scripts/operations/__tests__/resource-pool.test.mjs", "we:scripts/operations/resource-pool.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a positive control to the test. Read the ledger path through the wrapped fs once with ledgerR… (from web-everything/web-everything#7385 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/resource-pool-io.test.mjs:10` — Add a positive control to the test. Read the ledger path through the wrapped fs once with `ledgerReads` active and assert `ledgerReads` is non-empty. Also add an ESLint rule or check:standards pattern that bans `.endswith(` and `.startswith(` in test files.
2. `we:scripts/lib/__tests__/resource-pool-io.test.mjs:10` — Add a lint rule (e.g. a `check:standards` rule or ESLint) that flags non-existent String/Array method names like `endswith`/`startswith`/`tolower`. Add a convention that negative-assertion tripwires get a positive-control case, a test that deliberately triggers the guard and expects it to throw.
3. `we:scripts/operations/__tests__/resource-pool.test.mjs:8` — Add a deterministic CLI output regression using distinct pool and legacy decisions and asserting the digest plus all three comparison rows; this guard remains to be filed.
4. `we:scripts/operations/resource-pool.mjs:21` — Add a deterministic renderer regression with all three comparison rows and distinct pool/legacy decisions, asserting each appears in text output.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7385@dcc27ab33c745134bf13adf88bd99cc2d1ed0578

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
