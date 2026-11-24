---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/lib/fix-slot-borrow.mjs", "we:scripts/conveyor/__tests__/fix-executor-routing.test.mjs", "we:scripts/lib/fix-executor-chain.mjs", "we:scripts/settings/fix-executor.json", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/lib/__tests__/fix-slot-borrow.test.mjs", "we:scripts/lib/__tests__/fix-executor-chain.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a test that every reader of claim.meta.fixExecutor behaves correctly for Claude-stamped claim… (from web-everything/web-everything#7384 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1656` — Add a test that every reader of claim.meta.fixExecutor behaves correctly for Claude-stamped claims. Or give the stamp a separate field, so recordBorrowOutcome's guard cannot be tripped by new stamping.
2. `we:scripts/lib/fix-slot-borrow.mjs:143` — Add a createRoutedCiHealDispatch test asserting the stamped claim metadata for both Claude and non-Claude executors. Better still, stamp at the one site where the claim is acquired.
3. `we:scripts/conveyor/__tests__/fix-executor-routing.test.mjs:806` — Test the critical-flag × mode matrix for the routing decision. Alternatively state in the setting's comment that wrapped overrides the critical guarantee.
4. `we:scripts/lib/fix-executor-chain.mjs:130` — Add a check:standards rule or contract test that every decision field named requiresReview has at least one non-test consumer. Alternatively, land the review-dispatch wiring in the same PR.
5. `we:scripts/settings/fix-executor.json:4` — Add a test that asserts the shipped criticalGlobs match we:scripts/settings/fix-executor.json and we:scripts/lib/delivery-platform-preferences.json. Alternatively, make overrides additive to a non-removable floor.
6. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1618` — Add a table-driven test over mode × critical for dispatchFix that asserts which launcher fires. Alternatively, add a lint that requires every unqualified 'never' guarantee in a card to name the setting values it was tested under.
7. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1314` — Reuse a shared path-normalization helper (for example path.posix.normalize with a reject on `..`) for scope matching. Add a contract test for traversal inputs.
8. `(no file cited)` — Add a named integration check asserting direct Codex launch and zero Claude launches for critical and escalated dispatches, and attach the required live log evidence to its verification record.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7384@d8995cf0ff26422b53fb0259a3fb3a44de0abed9

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
