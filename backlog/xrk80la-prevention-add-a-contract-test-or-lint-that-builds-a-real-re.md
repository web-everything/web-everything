---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/provider-rotation-shadow.mjs", "we:scripts/lib/provider-rotation.mjs", "we:scripts/settings/provider-rotation.json", "we:scripts/lib/__tests__/provider-rotation-shadow.test.mjs", "we:scripts/lib/__tests__/provider-rotation.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a contract test or lint that builds a real review-seat row through the production row constru… (from web-everything/web-everything#7356 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/provider-rotation-shadow.mjs:75` — Add a contract test or lint that builds a real review-seat row through the production row constructor and asserts the shadow observer can derive a builder family from it. Otherwise, file a card to thread the builder identity into the seat rows before mode:on.
2. `we:scripts/lib/provider-rotation.mjs:235` — Add a test that routeFor refuses an unrecognised or missing mode before any mode:on precondition card closes. Better, add a lint or check:standards rule that an enum-mode switch must have an explicit refuse branch.
3. `we:scripts/lib/provider-rotation-shadow.mjs:40` — Add a table-driven test over every key lens crossed with every dispatch spelling (exact, review-seat:<lens>, plus conflicting row.lens or seat.lens) that asserts crossVendor.required stays true.
4. `we:scripts/settings/provider-rotation.json:619` — Add a test that a policy with review.crossVendorKeySeats set to a different valid list still treats correctness, security and red-team as key lenses. Alternatively, drop the field until it is consumed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7356@c3afac7b50172d059b438c192e332727e807a755

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
