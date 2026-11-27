---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/conveyor/rearm-review.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs", "we:scripts/conveyor/__tests__/rearm-review.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a replay test that feeds a realistic multi-paragraph final message through emitNoCodeOwedStan… (from web-everything/web-everything#7567 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/fix-run.mjs:1262` — Add a replay test that feeds a realistic multi-paragraph final message through `emitNoCodeOwedStandDown`. Alternatively, normalise and truncate the reason (single-line, capped) before building.
2. `we:scripts/conveyor/rearm-review.mjs:304` — A check that every exported decision-input parameter has at least one non-test call site, or an Acceptance line stating whether the consumer is wired in this card.
3. `we:scripts/operations/fix-run.mjs:648` — A lint rule that flags a JSDoc block whose `@returns` or `@param` names do not match the function that follows it.
4. `we:scripts/conveyor/rearm-review.mjs:459` — Add a soak or unit case that makes the first rearm attempt refuse on a transient read failure, then asserts a retry after the failure clears is still allowed. Alternatively, skip the no-change note for no-code candidates that were refused for unreadable evidence.
5. `we:scripts/conveyor/rearm-review.mjs:459` — Give the soak probe a `failComment` option and a case per refused scenario. A standards rule could require a named test for each 'even when X fails' guarantee.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7567@51ec16055eae888af6f7c34c780c650b9524aec7

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
