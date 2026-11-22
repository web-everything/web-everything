---
kind: story
size: 1
status: open
scope: ["we:scripts/operations/__tests__/run.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Test every declared CLI operation builds a CLI spec (no control-flag input collisions)

PR #7322's resolve-generated op declared an input named cwd, which collides with a reserved control flag in we:scripts/operations/cli-adapter.mjs (CONTROL_FLAGS), so the op could not run at all, not even --help. Only a per-op test caught it after red team. Add one test that loops over every declaration in OPERATIONS and CLI_ONLY_OPERATIONS (we:scripts/operations/run.mjs) and asserts buildCliSpec does not throw, so the next op cannot ship with a colliding input name (help, json, resume, answer, run-id, cwd).

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
