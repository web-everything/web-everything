---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/free-scope-io.mjs", "we:scripts/lib/codex-direct-task-sandbox.mjs", "we:scripts/operations/__tests__/free-scope-sandbox.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Codex sandbox can write the coordination dir (free-scope register/release)

Every Codex worker on 2026-10-17 hit EPERM on the scope-registry lock directory, so the drivers registered and released scope by hand. Fix: the Codex sandbox config grants write access to the coordination dir (or free-scope uses a path the sandbox already allows), so register and release work from inside a Codex worker. [A1] Executable: node --test we:scripts/operations/__tests__/free-scope-sandbox.test.mjs shows register then release succeeding under the Codex write-root list. Priority: top (operator 2026-10-17).

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
