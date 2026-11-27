---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/guard-lane.mjs", "we:scripts/__tests__/guard-lane.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Make resolveReal walk up to the deepest existing ancestor and rejoin the remaining segments. Add… (from web-everything/web-everything#7583 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/guard-lane.mjs:184` — Make `resolveReal` walk up to the deepest existing ancestor and rejoin the remaining segments. Add a parametrised test for new descendants at depth 1, 2 and 3 through a symlink. A lint or standards rule could require every path-prefix guard to test a deep non-existent descendant.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7583@840c6d86fac4dd6a50cfc41b9f7dac0ebdc2e84c

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
