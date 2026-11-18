---
bornAs: x0kvr2o
kind: story
size: 5
status: open
scope: ["we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/review-job-store.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Job SIGKILLed mid-loop orphans review-loop-cli; the next tick starts a second full review of the same PR

Flow-sim gap A-C2, class K7 (unserialized duplicate actors). Failing input: labels: [review:pending] files: 'we:review-jobs/review-N.json {pid:J}; completion review-N = started; run record review-pr-<uuid1>.json mid-judge (not parked); lane L1 leased under slug review-N; child `node we:scripts/operations/review-loop-cli.mjs --pr=N` still running' operator/OOM kills job pid J with SIGKILL (jetsam under … Cited: we:scripts/operations/review-loop-cli.mjs:657-658, we:scripts/operations/review-loop-cli.mjs:733-735, we:scripts/operations/review-job.mjs:326-332, we:scripts/operations/review-job.mjs:1526-1528, we:scripts/operations/review-job-store.mjs:115. Soak-break sketch: double-act: two panels and two verdict writes for one head. RD:1559-1571 counts the orphan loop against the live-round cap but does not stop a second round on the SAME PR.

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
