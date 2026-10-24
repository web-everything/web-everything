---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/record-red-team-ruling.mjs", "we:scripts/operations/__tests__/record-red-team-ruling.test.mjs", "we:scripts/lib/red-team-gate.mjs", "we:scripts/lib/__tests__/red-team-gate.test.mjs"]
dateOpened: "2026-10-22"
tags: []
---

# Prevention — A mutation-testing gate or a review lens that requires every throw in a planner to have a test as… (from web-everything/web-everything#5828 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/record-red-team-ruling.mjs:93` — A mutation-testing gate or a review lens that requires every `throw` in a planner to have a test asserting its own message regex.
2. `we:scripts/operations/__tests__/record-red-team-ruling.test.mjs:43` — Run the test with `WE_OPERATOR_LOGINS` set to two logins so the equality branch is isolated. Better still, have a lint check that a test named 'refuses X' asserts a message specific to X.
3. `we:scripts/lib/red-team-gate.mjs:567` — Add a human-authored carried-comment fixture to the shared-reader test. A broader fix is a test-plan lint that requires one assertion per guard disjunct on security-relevant `continue` branches.
4. `we:scripts/lib/red-team-gate.mjs:572` — Add a shared-reader test matrix of operator release lines against each result state (held, sent-back, advisory). A check that a prose guarantee in a doc comment has a named test would also catch it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5828@fb594fc1634f2e471de3cd087049564a3599a5e8

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
