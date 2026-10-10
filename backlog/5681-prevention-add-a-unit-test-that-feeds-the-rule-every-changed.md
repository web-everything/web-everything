---
bornAs: x701vjz
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/class-sweep-rule.mjs", "we:scripts/conveyor/class-sweep-check.mjs", "we:scripts/conveyor/__tests__/class-sweep-check.test.mjs", "we:scripts/lib/__tests__/class-sweep-rule.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a unit test that feeds the rule every changed-file name from a real PR file list, including b… (from web-everything/web-everything#4687 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/class-sweep-rule.mjs:148` — Add a unit test that feeds the rule every changed-file name from a real PR file list, including bracket, paren and space names, and asserts that naming the exact path covers it.
2. `we:scripts/conveyor/class-sweep-check.mjs:103` — Make the base-grammar test table-driven over each rejected shape (leading `-`, `..`, empty, over-long).
3. `we:scripts/lib/class-sweep-rule.mjs:195` — Use `Object.create(null)` or a `Map` for maps keyed by untrusted ids. A lint rule against `obj[untrustedKey] =` on plain object literals would catch the class. A one-line test with a `__proto__` finding id would pin it.
4. `we:scripts/conveyor/__tests__/class-sweep-check.test.mjs` — Add a deterministic test named 'readHeadBytes never requests bytes beyond its bound' that instruments underlying filesystem reads and asserts their requested ranges and total bytes; verify that replacing the helper with readFileSync makes it fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4687@785a9429f11e8fce546948e20b623fc0d08f7487

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
