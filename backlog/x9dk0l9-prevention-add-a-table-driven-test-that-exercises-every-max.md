---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/accept-carry-forward.mjs", "we:scripts/lib/__tests__/red-team-dispatch-queue.test.mjs", "we:scripts/lib/__tests__/accept-carry-forward.test.mjs"]
dateOpened: "2026-11-28"
tags: []
---

# Prevention — Add a table-driven test that exercises every MAX_MACHINE_* bound at each call site. A lint rule r… (from web-everything/web-everything#7630 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/accept-carry-forward.mjs:339` — Add a table-driven test that exercises every MAX_MACHINE_* bound at each call site. A lint rule requiring every exported bound constant to be referenced in a test would also catch this.
2. `we:scripts/lib/__tests__/red-team-dispatch-queue.test.mjs:88` — Make each table row declare the complete expected cause set and assert the emitted causes equal that set, including the simultaneous-barrier case.
3. `we:scripts/lib/__tests__/red-team-dispatch-queue.test.mjs:79` — Extend the named test with an expected set of causes and assert both emitted hold messages for the combined-barrier case.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7630@93983d2bb234ada0f59610333e8f684ff6ea5afc

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
