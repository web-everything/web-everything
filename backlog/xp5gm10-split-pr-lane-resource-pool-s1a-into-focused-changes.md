---
kind: story
size: 3
status: open
scope: ["we:docs/agent/settings-registry.md", "we:docs/agent/testing.md", "we:scripts/ci/test-timings.json", "we:scripts/lib/audit-settings.mjs", "we:scripts/lib/operator-override-reader.mjs", "we:scripts/lib/resource-pool-io.mjs", "we:scripts/lib/resource-pool.mjs", "we:scripts/lib/settings-registry-metadata.json", "we:scripts/operations/resource-pool.mjs", "we:scripts/operations/run.mjs", "we:scripts/settings/resource-pool.json"]
dateOpened: "2026-11-22"
tags: []
---

# Split PR lane/resource-pool-s1a into focused changes

size-split-key:c188f8415c6a3af15d06513706ae9de89d1f62b86176c6781cf06ce900c26a40. Plan follow-up splits for PR lane/resource-pool-s1a. File groups: we:docs/agent: 58; we:scripts/ci: 3; we:scripts/lib: 471; we:scripts/operations: 50; we:scripts/settings: 13

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
