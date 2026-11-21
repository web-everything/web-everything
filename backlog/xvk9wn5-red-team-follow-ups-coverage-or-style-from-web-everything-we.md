---
kind: story
size: 2
status: open
scope: ["we:scripts/__tests__/real-process-guard.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [coverage-or-style] from web-everything/web-everything#7112 (head 043ef6387)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7112 (reviewed head `043ef6387185527abd691b0433aa51beb25bca7e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/__tests__/real-process-guard.test.mjs:88` — (edge-case, degraded) The manifest guard accepts mock-only tests as real-process tests.
   - Scenario: Rename a mock-only test to we:example.real.test.mjs and list it in the manifest. Use 'import { spawnSync } from 'node:child_process'; vi.mock('node:child_process', () =&gt; ({ spawnSync: vi.fn() }));' and call 'spawnSync.mockReturnValue({ status: 0 })' inside its test. startsRealProcess treats that mock configuration call as a process invocation because it strips property accesses down to the imported spawnSync identifier. realTierProblems therefore accepts the file, while the new exclusion removes it from PR validation. The guard should reject this mock-only enrollment.
   - Class: coverage-or-style (basis: Static counterexample to the new AST guard: any call rooted at an imported child_process binding qualifies, including mockReturnValue. Exploitation requires a subsequent rename and manifest edit; no failure of the two currently enrolled smoke tests was reproduced.)
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
