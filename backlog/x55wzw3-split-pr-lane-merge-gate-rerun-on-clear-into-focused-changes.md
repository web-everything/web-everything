---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/soak/breaks/merge-gate-stale-after-clear.mjs", "we:scripts/lib/drain-blocked-reason.mjs", "we:scripts/lib/main-ci-reader.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/merge-gate-check.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Split PR lane/merge-gate-rerun-on-clear into focused changes

size-split-key:9faa774c8f207330c451e39edc45558b6fd09c1de6ee161b035310e0b95038c1. Plan follow-up splits for PR lane/merge-gate-rerun-on-clear. File groups: we:scripts/conveyor: 59; we:scripts/lib: 219; we:scripts/merge-ai-prs.mjs: 2; we:scripts/merge-gate-check.mjs: 25

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
