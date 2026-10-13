---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/file-item.mjs", "we:scripts/conveyor/"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention cards filed from plateau-app reviews prefix plateau paths as we:

Backlog triage 2026-10-13 found prevention/finding cards filed from plateau-app PR reviews cite plateau-app files with a we: locus, so 9 cards read as obsolete (path missing in WE) until re-checked against plateau-app. The finding/prevention filer must prefix paths with the reviewed PR's repo locus (plateau-app:) not a hard-coded we:.

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
