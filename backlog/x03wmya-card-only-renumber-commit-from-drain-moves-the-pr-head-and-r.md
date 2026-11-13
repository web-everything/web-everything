---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-13"
tags: []
---

# Card-only renumber commit from drain moves the PR head and re-blocks a clear PR; carry the prior red-team result

2026-11-13 (drain card renumber x48hcbk to 8191 on PR 6774). The renumber commit moves a PR head, which triggers a fresh red-team run and re-blocks an already-clear PR on the ruled residual. A card-only renumber delta should carry the prior red-team result. Code: we:scripts/conveyor

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

## Duplicate admission

capability-search found no matching open card
