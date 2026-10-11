---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/takeover-review.mjs", "we:scripts/conveyor/__tests__/takeover-review.test.mjs", "we:scripts/lib/review-settings.mjs", "we:scripts/lib/__tests__/review-settings.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a we:scripts/conveyor/__tests__/takeover-review.test.mjs case with two takeover signals separ… (from web-everything/web-everything#4759 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/takeover-review.mjs:63` — Add a we:scripts/conveyor/__tests__/takeover-review.test.mjs case with two takeover signals separated by a verdict, expecting a grant for the head pushed after the later one. Anchor on the latest signal that precedes the current head's push, or document the single-takeover assumption and gate it.
2. `we:scripts/conveyor/__tests__/takeover-review.test.mjs:96` — Add a table-driven test over every gate the grant path claims to preserve (CI gate, referral hold, review:human) in we:scripts/conveyor/__tests__/takeover-review.test.mjs.
3. `we:scripts/lib/review-settings.mjs:51` — Add a lint or standards note that a setting which widens a cap must fail closed on an invalid value. Alternatively, share one parser helper between review-settings and fix-takeover.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4759@80a17e8889deb466665ce1660b9606556e56083f

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
