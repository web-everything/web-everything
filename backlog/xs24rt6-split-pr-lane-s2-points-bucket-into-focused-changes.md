---
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing.md", "we:scripts/lib/gh-throttle.mjs", "we:scripts/lib/settings-registry-metadata.d/settings/ghThrottle.json", "we:scripts/settings/gh-throttle.json"]
dateOpened: "2026-11-25"
tags: []
---

# Split PR lane/s2-points-bucket into focused changes

size-split-key:4cc779dfefd88d00033a33c56841112760bd8ea1484d24a914d211b3ef62da4e. Plan follow-up splits for PR lane/s2-points-bucket. File groups: we:docs/agent: 56; we:scripts/lib: 252; we:scripts/settings: 3

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
