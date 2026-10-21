---
bornAs: xsqurha
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/file-item.mjs", "we:scripts/operations/__tests__/file-item.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Add a unit test with a throwing readTip for an ordinary filing. A reader-level contract test, 'or… (from web-everything/web-everything#5242 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/file-item.mjs:172` — Add a unit test with a throwing `readTip` for an ordinary filing. A reader-level contract test, 'ordinary filings never call readTip', is the cheapest durable guard.
2. `we:scripts/operations/file-item.mjs:78` — Compute one `isOperatorTask(input)` predicate in `we:scripts/backlog/operator-task.mjs` and import it in both places. Add a test that a non-boolean `operatorTask` is refused.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5242@72e418e28c1cab6371928510d5f42a7c16bb1673

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
