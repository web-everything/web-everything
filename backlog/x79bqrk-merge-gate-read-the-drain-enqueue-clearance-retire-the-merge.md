---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-gate-check.mjs", "we:scripts/settings/merge-queue.json"]
dateOpened: "2026-10-09"
tags: []
---

# merge-gate: read the drain enqueue clearance + retire the mergeQueue.strategy alias

Follow-up of xtpxusq. The drain now stamps a we-drain-enqueue-clearance comment per judged head before it enqueues; the drain-merge-strategy lib exports readEnqueueClearance. Wire it into the merge-gate check's gatherPrFacts (replace the null enqueueClearance fact; read comments with author login) and choose the trusted author list (the drain's gh identity; fail closed when unset). Also retire or alias the drain-internal mergeQueue.strategy setting so the cascade has one strategy key. Deferred because the check script was held by red-main-freeze-shared and the settings file by PR 4689.

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
