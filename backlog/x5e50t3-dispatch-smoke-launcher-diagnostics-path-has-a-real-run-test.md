---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/dispatch-smoke-launch.mjs", "we:scripts/lib/dispatch-smoke-launch.real-run.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Dispatch-smoke launcher diagnostics path has a real-run test

Priority: expedite (operator 2026-10-17, from PR #5460's review; the expedite outcome isn't built yet, so treat it as top priority). Add a test that really runs the launcher diagnostics path in we:scripts/lib/dispatch-smoke-launch.mjs (not mocked). Acceptance: [A1] Executable - the new test spawns the launcher for real, forces a failure, and asserts the allow-listed summary and the 0600 local stderr file; passes under vitest.

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
