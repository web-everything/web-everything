---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/soak/breaks/deps-job-builtins-only-import-chain.mjs", "we:scripts/conveyor/soak/breaks/deps-job-builtins-only-import-chain.soak.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/deps-job-builtins-only-import-chain.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add table-driven cases for class instance fields, static fields and static blocks to the walker t… (from web-everything/web-everything#7421 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/soak/breaks/deps-job-builtins-only-import-chain.mjs:62` — Add table-driven cases for class instance fields, static fields and static blocks to the walker test, folded into the DEPS-SOAK-HARDEN follow-up card.
2. `we:scripts/conveyor/soak/breaks/deps-job-builtins-only-import-chain.mjs:63` — Add a deterministic walker regression test contrasting an uninstantiated instance field with a startup static field initializer.
3. `we:scripts/conveyor/soak/breaks/deps-job-builtins-only-import-chain.soak.test.mjs:157` — Add a named integration test, `deps import break proves red on reversed fix and green on main`, that runs the replay in a disposable checkout and asserts both outcomes.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7421@4e8ae086c8e7d1355b335a2a0a07fa84bfd2f694

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
