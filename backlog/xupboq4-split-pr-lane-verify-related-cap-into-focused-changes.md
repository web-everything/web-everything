---
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing.md", "we:scripts/ci/test-timings.json", "we:scripts/conveyor/soak/breaks/verify-related-cap-ceiling.mjs", "we:scripts/conveyor/verify-dispatch.mjs", "we:scripts/conveyor/verify-gate-job.mjs", "we:scripts/lib/lane-verify.mjs", "we:scripts/lib/related-test-selection.mjs", "we:scripts/lib/verify-lane-gate.mjs", "we:scripts/verify-lane.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Split PR lane/verify-related-cap into focused changes

size-split-key:706fcc2d9f8e9b849fae7e552766a9ece37285fe30da4cc255a2847932355303. Plan follow-up splits for PR lane/verify-related-cap. File groups: we:docs/agent: 10; we:scripts/ci: 1; we:scripts/conveyor: 145; we:scripts/lib: 138; we:scripts/verify-lane.mjs: 43

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
