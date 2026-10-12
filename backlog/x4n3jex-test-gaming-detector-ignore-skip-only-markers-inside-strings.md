---
kind: story
size: 1
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Test-gaming detector: ignore skip/only markers inside strings and comments

Held finding 221 (2026-10-10). Live #4717: drain refused "test-gaming suspected - test-skipped: we:scripts/lib/__tests__/merge-gate-ci.test.mjs (1 skip/only marker)" but the marker was it.skip("x", ...) inside a fixture string the detector own test commits. Fix: strip string/template literals and comments (or parse) before counting skip/only markers in the drain anti-test-gaming scan (we:scripts/merge-ai-prs.mjs); test with that exact line. Related: #2669.

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
