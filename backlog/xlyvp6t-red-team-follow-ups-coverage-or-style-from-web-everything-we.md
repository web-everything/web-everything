---
kind: story
size: 2
status: open
scope: ["we:scripts/__tests__/real-process-guard.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [coverage-or-style] from web-everything/web-everything#7112 (head ba1a9f8b8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7112 (reviewed head `ba1a9f8b8d72b5b2a6e9547ad0808a3f091a4576`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/__tests__/real-process-guard.test.mjs:63` — (failing-input, degraded) Mocked child_process calls pass the real-process admission guard
   - Scenario: Rename a unit test to we:unit.real.test.mjs and list it in the manifest. Its source imports spawnSync from node:child_process, mocks that module with vi.mock returning a vi.fn, and calls spawnSync(process.execPath, []) inside its test. A read-only probe of the actual guard returned startsRealProcess=true and realTierProblems=[] for this input. No real subprocess executes, but the test leaves PR validation and enters the scheduled tier. The guard should reject this mock-only test under its stated admission rule.
   - Class: coverage-or-style (basis: The guard's pure functions were evaluated directly with the mocked-test source and accepted it. This demonstrates a test-tier admission gap; no product runtime failure or full CI run was reproduced.)
   - Claude's re-check: demonstrated break

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
