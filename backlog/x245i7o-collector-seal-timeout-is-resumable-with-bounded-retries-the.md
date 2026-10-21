---
kind: story
size: 3
parent: "x87psvt"
status: open
blockedBy: ["x5nmdnt"]
scope: ["we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/card-batch-seal.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Collector seal timeout is resumable with bounded retries then a held reason

Per decision x5ioz96 fork 6 skeptic amendment: the root cause of the stuck batch is the seal job timing out (spawnSync ETIMEDOUT) and leaving step ready terminal. A seal timeout resumes from the last completed step with a bounded retry count (a setting with its source logged), then holds with a named reason.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/operations/__tests__/card-batch-seal-io.test.mjs` fails before this item lands and passes after. Planned cases:
  - `timeout at step ready resumes from the last completed step on the next tick` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs).
  - `retry count is bounded by the setting, with its source logged` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs).
  - `retry exhaustion holds with a named reason` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — the state keeps sealedAt and the held reason names the timed-out step.

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
