---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Concurrent fast drains each run the same queue-merged follow-up; attempts counter advances per drain

Flow-sim gap D-C8, class K7 (unserialized duplicate actors). Failing input: pending[{num:N, followUpAttempts:0}], PR N MERGED by GitHub; catchUp concurrency=3 (we:merge-queue.json) plus event-triggered fast drains' 'two --only fast drains (lease bypassed, MAP:2924-2927) run collectQueueMerged within the same minute Cited: we:scripts/lib/drain-merge-strategy.mjs:664-710, we:scripts/lib/drain-merge-strategy.mjs:705, we:scripts/merge-ai-prs.mjs:7435-7447, we:scripts/lib/drain-merge-strategy.mjs:725, we:scripts/merge-ai-prs.mjs:7297-7312. Soak-break sketch: none

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
