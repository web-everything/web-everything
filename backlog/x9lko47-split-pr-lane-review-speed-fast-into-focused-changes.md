---
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing/review-fast-pass-admission.md", "we:docs/agent/testing/review-fast-pass.md", "we:scripts/conveyor/review-stack-base.mjs", "we:scripts/conveyor/soak/breaks/review-pending-fast-pass.mjs", "we:scripts/lib/main-staleness.mjs", "we:scripts/lib/review-dispatch-context.mjs", "we:scripts/lib/review-fast-pass-cli.mjs", "we:scripts/lib/review-fast-pass.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/review-job.mjs", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Split PR lane/review-speed-fast into focused changes

size-split-key:76e38b5cd4c8de9ab7823213dc169d3c8167cb5114c8582deffdacfa58be0c2f. Plan follow-up splits for PR lane/review-speed-fast. File groups: we:docs/agent: 36; we:scripts/conveyor: 52; we:scripts/lib: 241; we:scripts/operations: 36; we:skills-src/conveyor: 22

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
