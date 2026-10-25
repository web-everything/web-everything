---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Cut wrapper token cost: make codex-direct-task end-to-end

[held entry 282] (operator 2026-10-13 ~18:00 ET, held — build next free slot, via Codex directly) Cut wrapper token cost: make codex-direct-task end-to-end. Today each Claude wrapper used ~100k–345k tokens (grouped builds 345k, 2982 192k, ci-routing 324k) mostly on leasing, verify waits, open-pr, edge-load retries and log reading. Add an end-to-end mode: codex-direct-task --task-file --lane=auto --verify --open-pr --body-file --edge-clone=<clone> that does lease → codex → verify → commit/push → open-pr → overlay load → adoption check → release, and prints a ≤8-line JSON report. Then the orchestrator runs Codex with no wrapper for scoped work. Also: a --compact worker-brief, and log per-task wrapper tokens to a ledger so the saving is measured.

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
