---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/agent-launch-approved.json", "we:scripts/lib/agent-launch-guards.json", "we:scripts/lib/agent-launch.mjs", "we:scripts/lib/permission-change.mjs", "we:scripts/lib/repo-scan-tests.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Split PR lane/rs-7170-1-v2 into focused changes

size-split-key:95bdd2c17ca9fbe023ea840982c37291bb1b96ca9ae666918e4b6db223650a03. Plan follow-up splits for PR lane/rs-7170-1-v2. File groups: we:scripts/lib: 398

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
