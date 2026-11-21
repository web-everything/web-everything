---
kind: story
size: 2
status: open
scope: ["we:scripts/__tests__/real-process-guard.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [coverage-or-style] from web-everything/web-everything#7112 (head fdc1cd99a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7112 (reviewed head `fdc1cd99a6d8be15d69b430b976fa53765e030c7`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/__tests__/real-process-guard.test.mjs:63` — (edge-case, degraded) The real-tier guard accepts fully mocked subprocess tests.
   - Scenario: Rename a unit test to we:x.real.test.mjs and list it in the manifest. Its source imports spawnSync, replaces node:child_process with vi.mock returning a fake spawnSync, and calls that mock inside a test. The actual guard returns startsRealProcess=true and realTierProblems=[] despite no subprocess starting. The default suite then excludes the test, moving mock-only validation out of PR checks. The guard should reject this mocked-only input.
   - Class: coverage-or-style (basis: Executed the actual guard functions in memory against this source and observed acceptance. An uncalled function containing spawnSync also passed. This demonstrates a validation gap; no production failure in the two current real-tier tests was established.)
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
