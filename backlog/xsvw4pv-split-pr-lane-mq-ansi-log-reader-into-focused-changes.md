---
kind: story
size: 3
status: open
scope: ["we:docs/agent/settings-registry.md", "we:docs/agent/testing.md", "we:scripts/ci/test-timings.json", "we:scripts/conveyor/mq-failure-intake.mjs", "we:scripts/conveyor/soak/breaks/drain-mq-log-reader-escape-sequences.mjs", "we:scripts/conveyor/soak/breaks/mq-unreadable-log-single-retry.mjs", "we:scripts/lib/ansi-log-text.mjs", "we:scripts/lib/drain-mq-failure-recovery-io.mjs", "we:scripts/lib/drain-mq-failure-recovery.mjs", "we:scripts/lib/drain-mq-flake-rerun.mjs", "we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/mq-failure-route.mjs", "we:scripts/lib/settings-registry-metadata.json", "we:scripts/settings/drain-mq-retry.json"]
dateOpened: "2026-11-22"
tags: []
---

# Split PR lane/mq-ansi-log-reader into focused changes

size-split-key:184fa9f38529f2807466383d62008fe2ae0adfb3b1458af30d0bfaba93c73c64. Plan follow-up splits for PR lane/mq-ansi-log-reader. File groups: we:docs/agent: 22; we:scripts/ci: 3; we:scripts/conveyor: 153; we:scripts/lib: 1195; we:scripts/settings: 14

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
