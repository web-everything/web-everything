---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/dep-trace.mjs", "we:scripts/ci/__tests__/dep-trace.test.mjs", "we:docs/agent/testing.md"]
dateOpened: "2026-11-21"
tags: []
---

# dep-trace: capture every built-in the tracer calls, and scan only Node options before the script path

Found by the PR #7123 fix self-review (round 2). we:scripts/ci/dep-trace.mjs calls shared Array/String methods (includes, push, some, startsWith, split) at spawn time, so a test that patches them has its code run inside the observe-only tracer. Separately, every spawn argument is scanned for untraced Node flags, so a script argument like -c marks the trace incomplete for no reason (safe, but loses completeness). Fix: capture the built-ins at module load (uncurryThis) and scan only arguments before the script path; add a named test for each.

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
