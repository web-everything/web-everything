---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/red-team-foreign-host-stale.mjs", "we:scripts/operations/review-job.mjs"]
dateOpened: "2026-11-09"
tags: []
---

# Red-team remote-owner heartbeat evidence: a red-team status record owned by another host carries a heartbeat so staleness is judged by heartbeat age, not pid liveness (R757 residual from #6562)

R757 (operator accepted the residual on #6562): a red-team status record owned by another host can lose protection after the stale window, because pid liveness cannot be probed across hosts. Make the owner write a heartbeat into the status record, and judge a foreign-host record stale by heartbeat age. Residual from PR #6562 finding at we:scripts/lib/red-team-foreign-host-stale.mjs:25; the writer is the red-team status record writer in we:scripts/operations/review-job.mjs.

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
