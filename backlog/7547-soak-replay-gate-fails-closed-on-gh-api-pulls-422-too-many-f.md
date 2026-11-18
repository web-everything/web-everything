---
bornAs: xb76fl5
kind: task
status: open
scope: ["we:.github/workflows/soak-replay-gate.yml"]
dateOpened: "2026-10-31"
tags: []
---

# soak-replay-gate fails closed on gh api pulls 422 too many files changed

2026-10-30 09:46 ET: we:.github/workflows/soak-replay-gate.yml fails closed when gh api pulls/N returns 422 'too many files changed' (cached-diff glitch; #6059 has 27 files). Fall back to gh pr view --json body or GraphQL for the body fetch. Instance cleared by a no-op merge push (3da43988b4).

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
