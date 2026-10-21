---
bornAs: xcdpii1
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/review-status-tag.test.mjs", "we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:scripts/lib/handoff-settings.mjs", "we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs", "we:scripts/lib/__tests__/handoff-settings.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a coverage rule or review lens: every new injected side-effect seam needs a test that asserts… (from web-everything/web-everything#5462 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/review-status-tag.test.mjs:10` — Add a coverage rule or review lens: every new injected side-effect seam needs a test that asserts it is called, not only one that stubs it.
2. `we:scripts/conveyor/ci-red-recovery-watch.mjs:1247` — Give each cascade leaf a consumer-level test that moves the value through the platform, tool and env layers and asserts the consumer's behaviour changes.
3. `we:scripts/lib/handoff-settings.mjs:14` — Add a table-driven test over every key in `handoff-settings` that asserts each cascade layer, env included, moves the resolved value.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5462@9e20c5e5c0217cc978e8ea190ce8c48194026f73

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
