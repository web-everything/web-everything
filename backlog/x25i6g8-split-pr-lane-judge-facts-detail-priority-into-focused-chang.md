---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/judge-sweep-exit-rulings.mjs", "we:scripts/operations/judge-sweep-facts-io.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Split PR lane/judge-facts-detail-priority into focused changes

size-split-key:4e00d152b8850645b371a28ef46981284e1a08eaa7baaab7910132ce5a8097d4. Plan follow-up splits for PR lane/judge-facts-detail-priority. File groups: we:scripts/operations: 383

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
