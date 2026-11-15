---
kind: story
size: 3
parent: "5452"
status: open
scope: ["we:scripts/conveyor/pr-events-worker/worker.mjs", "we:scripts/conveyor/pr-events-worker/core.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# pr-events runtime writers: per-role write tokens (decider vs executors) so the writer role is proven, not claimed

Follow-up to #5453: POST /runtime-events uses the shared PR_EVENTS_BOOTSTRAP_TOKEN, so the recorded writer role is claimed, not proven. Per-role write tokens need new secret bindings in we:scripts/conveyor/pr-events-worker/worker.mjs; secret storage is an operator decision (rule 14).

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
