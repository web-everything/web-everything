---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/dispatch-bg-isolation.mjs", "we:scripts/lib/__tests__/dispatch-bg-isolation.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a parameterized Vitest case for unknown status, missing status, and omitted repo, asserting b… (from web-everything/web-everything#7597 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/dispatch-bg-isolation.mjs:104` — Add a parameterized Vitest case for unknown status, missing status, and omitted repo, asserting both event arrays are empty, and run it in the existing test gate.
2. `we:scripts/lib/dispatch-bg-isolation.mjs:105` — Add the named parameterized regression test to the test gate; changing unknown-status handling to use the fallback must make it fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7597@d23882686bad1fc6b4e905e16cc92c791b853d0b

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
