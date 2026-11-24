---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/push-gate-lint.mjs", "we:scripts/lib/repo-scan-tests.mjs", "we:scripts/push-gate-allowlist.json"]
dateOpened: "2026-11-24"
tags: []
---

# Split PR lane/push-gate-s2 into focused changes

size-split-key:cd755134edae2fc3d29f59b36f37d6a9e4ecc935ef8d59a5f384dd7acf55e6cb. Plan follow-up splits for PR lane/push-gate-s2. File groups: we:scripts/lib: 124; we:scripts/push-gate-allowlist.json: 350

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
