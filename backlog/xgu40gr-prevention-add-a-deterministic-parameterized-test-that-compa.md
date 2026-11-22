---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/shadow-flags-retired.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a deterministic parameterized test that compares actual drain and merge-gate outputs under ol… (from web-everything/web-everything#7339 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/shadow-flags-retired.test.mjs:243` — Add a deterministic parameterized test that compares actual drain and merge-gate outputs under old-shadow and retired settings, including successful decisions.
2. `(no file cited)` — Add a deterministic registry check named 'every KILL shadow has its retirement recorded' against the retirement inventory.
3. `(no file cited)` — Add a deterministic check named 'retirement measurements cover all three systems before and after' requiring dated windows and counts for each system.
4. `we:scripts/lib/__tests__/shadow-flags-retired.test.mjs:243` — Add a parameterized counted-path equivalence test that varies resolved shadow settings and asserts identical drain and merge-gate outputs, with a negative control proving each applicable setting reaches its production consumer.
5. `(no file cited)` — Add named deterministic handoff checks that validate all retirement registry entries and require dated before/after measurement records for the three specified observers.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7339@6a73410ac91147afb065d6818ecca4c6a5371aa8

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
