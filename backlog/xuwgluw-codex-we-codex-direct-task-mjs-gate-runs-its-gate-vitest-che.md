---
kind: story
size: 2
status: open
scope: ["we:codex-direct-task.mjs", "we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Codex `we:codex-direct-task.mjs --gate=...` runs its gate (vitest/check:standards) INSIDE the Codex sandbox on

HIGH priority hint. - [HIGH 2026-10-31 12:24 ET] Codex `we:codex-direct-task.mjs --gate=...` runs its gate (vitest/check:standards) INSIDE the Codex sandbox on the Mac, bypassing heavy-admission → never reaches Forge; most worker test load today. Route the gate command through `node we:scripts/readiness/heavy-admission.mjs run -- a placeholder-named file` (allowlisting the admission dir is already in writable_roots). Evidence: Mac 44-79 all day, Forge ~1; wrapped 3-file run went remote (receipts 477→479). Also: forge-wrap-vitest user hook prototype tried 12:17-12:23 and REMOVED (needed permissionDecision allow; big runs already enforced by guard-bash heavy-enforce).

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
