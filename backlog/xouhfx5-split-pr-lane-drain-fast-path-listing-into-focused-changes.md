---
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing.md", "we:scripts/lib/enqueue-on-event.mjs", "we:scripts/lib/fast-drain-context.mjs", "we:scripts/lib/fast-drain-scope.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Split PR lane/drain-fast-path-listing into focused changes

size-split-key:c87be003e680dbaaff4e7b73b0f80ae80bfd1d527ec71aa9fada22519db55759. Plan follow-up splits for PR lane/drain-fast-path-listing. File groups: we:docs/agent: 26; we:scripts/lib: 183; we:scripts/merge-ai-prs.mjs: 138

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
