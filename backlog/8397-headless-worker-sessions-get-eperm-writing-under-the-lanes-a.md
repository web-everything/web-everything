---
bornAs: x0wov1n
kind: story
size: 3
status: active
scaffoldedBy: "cards-batch-21"
dateScaffolded: "2026-11-16"
scope: ["we:scripts/"]
dateOpened: "2026-11-16"
tags: []
related: ["5315"]
---

# Headless worker sessions get EPERM writing under the lanes admission directory

Sandboxed agent sessions get EPERM writing under the lanes .admission directory (rename of .admission/remote/<id> at 17:23 and 17:50, mkdir .admission/remote/<id> at 20:37, ci-heal #6890 no-change at 01:10Z from EPERM). Product fix: the session sandbox write allow-list for headless/worker sessions must include exactly the lanes .admission/** tree (find where the dispatch sets sandbox settings). Evidence: remote-fallbacks.jsonl.

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

## Duplicate admission

Codex build sandbox and the admission lock folder
