---
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/operations/review-job-store.mjs", "we:scripts/operations/worker-wrapper-launch.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# blocked-on-infra cool-off for a review JOB is only enforced while a row exists, and the row vanishes at job e…

Flow-sim gap A-C3, class K7 (unserialized duplicate actors). Failing input: labels: [review:pending] files: 'completion review-N = {v:2, launcher:'node-job', status:'done', outcome:'blocked-on-infra', label:'review-loop timed out after 2700000ms' (or 'exit 1 (effect-halted)...' or a crash label), updatedAt:t}; NO we:review-jobs/review-N.json (unclaim RJ:1325)' next tick at t+120 s (also the case after … Cited: we:scripts/conveyor/reconcile-pass.mjs:545, we:scripts/operations/review-job-store.mjs:107-119, we:scripts/operations/worker-wrapper-launch.mjs:158, we:scripts/conveyor/reconcile-core.mjs:964-1026, we:scripts/conveyor/reconcile-core.mjs:970. Soak-break sketch: double-act / hot retry: a timed-out, crashed or void-halted review is re-run in full every tick (bounded only by RD:1579-1611 live-round cap, RD:614-618 host admission, and RRH same-head hold for runs that completed the `read` step). infraStreak / 'infra-retr…

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
