---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/dep-trace.mjs", "we:scripts/ci/__tests__/dep-trace.test.mjs", "we:docs/agent/testing.md"]
dateOpened: "2026-11-21"
tags: []
---

# dep-trace: Worker, ChildProcess.prototype.spawn and process.execve start code the tracer neither traces nor flags

Found by the PR #7123 fix self-review. we:scripts/ci/dep-trace.mjs wraps the exported child_process functions only. new Worker(...), a direct ChildProcess.prototype.spawn call and process.execve run code (or replace the process) without a spawn edge or an incomplete flag, so replay can read their reads as absent. Fix observe-only: mark the evidence incomplete on each path (same peek-based safe reads, untouched arguments) and add a named test per path.

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
