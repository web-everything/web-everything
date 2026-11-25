---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/delivery-strategy.mjs", "we:scripts/conveyor/__tests__/fixtures/strategy-replay.ours.json", "we:scripts/lib/protected-path-floor.mjs", "we:scripts/conveyor/__tests__/delivery-strategy.test.mjs", "we:scripts/lib/__tests__/protected-path-floor.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a table-driven test that calls every exported function (select, decisionFindings, replayFindi… (from web-everything/web-everything#7492 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/delivery-strategy.mjs:196` — Add a table-driven test that calls every exported function (`select`, `decisionFindings`, `replayFindings`, `tableChangeFindings`) with each argument undefined and expects a refusal, not a throw. Fold it into card S1.1c.
2. `we:scripts/conveyor/__tests__/fixtures/strategy-replay.ours.json:2200` — Add a deterministic check (a test or a check:standards rule) that every top-level array in a `*.ours.json` replay fixture is consumed by at least one test. The cheapest form is one loop test over `replay.records`.
3. `we:scripts/lib/protected-path-floor.mjs:136` — Add a check:standards rule or test that every file in STANDALONE_POLICY_FILES also appears in FLOOR_SETTINGS.
4. `we:scripts/conveyor/__tests__/delivery-strategy.test.mjs` — Add a CI-enforced AST dependency check for the pure selector that permits node:crypto while rejecting I/O imports, dynamic loading and ambient network APIs; expose it through the named test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7492@e5dc531d3bca804cbd28fe35bf438c8ddf45c569

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
