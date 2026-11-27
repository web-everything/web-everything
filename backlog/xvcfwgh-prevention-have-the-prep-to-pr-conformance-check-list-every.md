---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/fix-slot-borrow.mjs", "we:scripts/lib/__tests__/fix-slot-borrow.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Have the prep-to-PR conformance check list every Spec bullet that changes a user-visible string,… (from web-everything/web-everything#7618 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/fix-slot-borrow.mjs:58` — Have the prep-to-PR conformance check list every Spec bullet that changes a user-visible string, and require a test that asserts the literal string (e.g. expect(claudeOnlyReason({codexUnproductive:2})).toMatch(/counted runs.*moves up the fixer chain/)).
2. `we:scripts/lib/__tests__/fix-slot-borrow.test.mjs:187` — Start the mixture loop at total=1 rather than 3, asserting `total >= 3 ? max(model,total-1) : model`. That pins every row count in one test. A test-plan-to-test mapping lens in review would catch dropped table rows.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7618@6d4a97dea472c730d9a7aaf17c766a0280860351

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
