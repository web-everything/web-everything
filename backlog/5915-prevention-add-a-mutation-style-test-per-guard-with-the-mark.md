---
bornAs: x5jtqz5
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/daemon-rebuild-wrong-branch-heal.test.mjs", "we:scripts/lib/daemon-rebuild/wrong-branch-heal.mjs", "we:scripts/lib/daemon-rebuild/__tests__/wrong-branch-heal.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a mutation-style test per guard with the marker injected at a distinct git call. A review-len… (from web-everything/web-everything#4964 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/daemon-rebuild-wrong-branch-heal.test.mjs:196` — Add a mutation-style test per guard with the marker injected at a distinct git call. A review-lens rule that each redundant guard needs its own failing test would catch this class.
2. `we:scripts/lib/daemon-rebuild/wrong-branch-heal.mjs:75` — Make the guard parameter required, or default it to `null` (fail closed), and update the older pure-rule tests to pass `inProgress: []` explicitly. A lint or review rule that safety-gate inputs must not have permissive defaults would catch this whole class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4964@5276a53f26f0f3f8c12a8468c4ccfbd94082cbe6

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
