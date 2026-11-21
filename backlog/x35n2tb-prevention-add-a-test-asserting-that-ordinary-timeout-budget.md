---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a test asserting that ordinary timeout budget and followup filing are independent of staleFre… (from web-everything/web-everything#7280 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/ci-heal-pr-dispatch.mjs:1020` — Add a test asserting that ordinary timeout budget and followup filing are independent of `staleFreeze` requests on the same head. Better, have `confirmedTimeouts` exclude `r.staleFreeze`, so the per-kind caps are enforced in one place.
2. `we:scripts/conveyor/reconcile-core.mjs:2903` — Add a mutation or negative-case rule to the stale-freeze test card: every guard in a new planner branch needs one refusing fixture. Where practical, a standards check could flag new `&&` binding guards that have no matching negative test.
3. `we:scripts/operations/ci-heal-pr-dispatch.mjs:1013` — Add a check:standards rule, or a review-lens checklist item: any new early `refuse(...)` or return-on-invalid line needs a test that asserts that exact reason string.
4. `we:scripts/conveyor/reconcile-core.mjs:3197` — Require one negative fixture per new guard condition in planner branches. A table-driven test over the label and phase matrix would catch this class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7280@d3914c1c8c8b8e6c994642dd2ca7d6428e312bec

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
