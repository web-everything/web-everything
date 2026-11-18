---
bornAs: xca8ax2
kind: story
size: 3
status: open
scope: ["we:scripts/lib/merge-queue-stuck-dequeue.mjs", "we:scripts/lib/drain-queue-safety.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# 'rebuilds' dequeue has no durable cap: dequeue -> re-enqueue loop

Flow-sim gap D-C9, class K14 (progress counter counts only successes). Failing input: PR in GitHub queue state AWAITING_CHECKS whose group commit changed >= queueRebuildMax(3) times (a flaky or red batch partner); labels [ready-to-merge, review:accepted]; we:drain-merge-queue-stuck.json tracker count>=3' 'stuck sweep runs Cited: we:scripts/lib/merge-queue-stuck-dequeue.mjs:68, we:scripts/lib/merge-queue-stuck-dequeue.mjs:111, we:scripts/lib/drain-queue-safety.mjs:63. Soak-break sketch: none

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
