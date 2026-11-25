---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/protected-path-floor.mjs", "we:scripts/conveyor/__tests__/fixtures/strategy-replay.ours.json", "we:scripts/conveyor/delivery-strategy.mjs", "we:scripts/conveyor/__tests__/delivery-strategy.test.mjs", "we:scripts/lib/__tests__/protected-path-floor.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a check:standards or unit test that every file in STANDALONE_POLICY_FILES also appears in FLO… (from web-everything/web-everything#7492 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/protected-path-floor.mjs:135` — Add a check:standards or unit test that every file in STANDALONE_POLICY_FILES also appears in FLOOR_SETTINGS.
2. `we:scripts/conveyor/__tests__/fixtures/strategy-replay.ours.json:2310` — Add a test that replays every fixture record through decisionFindings, or remove the records from the fixture.
3. `we:scripts/conveyor/delivery-strategy.mjs:196` — Require every exported validator to accept undefined table and settings, backed by a table-driven test.
4. `we:scripts/lib/protected-path-floor.mjs:136` — Add a drift test that every STANDALONE_POLICY_FILES entry is also in FLOOR_SETTINGS. This is a deterministic gate.
5. `we:scripts/conveyor/__tests__/delivery-strategy.test.mjs:193` — Use vi.useFakeTimers with a throwing system time, or a lint rule banning Date/performance reads in we:scripts/conveyor/delivery-strategy.mjs.
6. `we:scripts/conveyor/__tests__/delivery-strategy.test.mjs` — Add a deterministic dependency-boundary lint gate restricting the selector to approved pure dependencies and rejecting filesystem, network and process I/O, including dynamic imports.
7. `we:scripts/conveyor/__tests__/delivery-strategy.test.mjs` — Add a deterministic purity lint gate for the selector that restricts imports and rejects ambient IO and implicit clock APIs.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7492@22ca63f9c656ffd0396ea4571a3df567b7107390

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
