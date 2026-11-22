---
kind: story
size: 2
status: open
scope: ["we:scripts/__tests__/real-process-guard.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [coverage-or-style] from web-everything/web-everything#7112 (head f1df0ecbb)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7112 (reviewed head `f1df0ecbbba5fd06213fa4c2aa2b0bce36e30263`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/__tests__/real-process-guard.test.mjs:88` — (failing-input, degraded) Mock configuration counts as starting a real process, bypassing the tier guard.
   - Scenario: A test imports spawnSync from node:child_process, mocks that module with vi.mock, and calls only spawnSync.mockReturnValue inside its test. Rename it to we:mock-only.real.test.mjs and add it to the manifest. The guard accepts it because it treats any method call rooted at the imported binding as process execution. The default suite then excludes this mock-only test. The guard should reject the migration because no subprocess is started.
   - Class: coverage-or-style (basis: Executed the actual guard functions with the TypeScript parser against this mock-only source: startsRealProcess returned true, scansRealProcess returned false, and realTierProblems returned an empty array. This demonstrates a CI coverage-enforcement gap; no existing migrated test or production behavior was shown to fail.)
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
