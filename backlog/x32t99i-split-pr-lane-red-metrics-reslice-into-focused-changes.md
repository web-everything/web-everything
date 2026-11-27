---
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing/main-red-metrics.md", "we:scripts/conveyor/main-ci-red-core.mjs", "we:scripts/conveyor/main-red-metrics-journal.mjs", "we:scripts/lib/protected-path-floor.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Split PR lane/red-metrics-reslice into focused changes

size-split-key:2c4133d2876c20355aae21543b9c5f0ce875f8565361dd7c7d43ed067f6e7df8. Plan follow-up splits for PR lane/red-metrics-reslice. File groups: we:docs/agent: 66; we:scripts/conveyor: 257; we:scripts/lib: 2

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
