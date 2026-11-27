---
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing/credential-cutover-evidence-races.md", "we:scripts/operations/host-credential-cutover.mjs", "we:scripts/settings/privacy-terms-allowlist.json"]
dateOpened: "2026-11-27"
tags: []
---

# Split PR lane/ctn-repin-s1a into focused changes

size-split-key:bb1a393bc9024e4cbf8080a631d6a1a59a75f05943e88eeb9a4590e3b591c6bb. Plan follow-up splits for PR lane/ctn-repin-s1a. File groups: we:docs/agent: 10; we:scripts/operations: 512; we:scripts/settings: 56

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
