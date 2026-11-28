---
kind: task
status: open
scope: ["we:scripts/operations/effect-executor.mjs", "we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/operations/wake.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/review-settings.mjs", "we:scripts/lib/settings-registry.mjs"]
dateOpened: "2026-11-28"
tags: []
---

# REVIEW-EFFECT-KILLED-MID-SWAP: prove a pending non-idempotent effect from GitHub + ledger; derive the review loop timeout from data

PRIORITY: merge-blocker (the red-team gate deadlocks PR #7629 and any run killed in the same window; hand edit is the only exit today). PROBLEM: 2026-11-28 05:33 ET #7629 red team blocked. The review run was accepted, but the loop was killed by the 45 min timeout (DEFAULT_LOOP_TIMEOUT_MS in we:scripts/operations/review-job.mjs, line 178) about 2 s after the review.label-swap reached GitHub (ledger accepted 10:23:57Z, comment 10:24:10Z) and before the result was written. The effect stayed pending with unknownAttempts 1, so we:scripts/operations/effect-executor.mjs (pending non-idempotent branch near line 285) refuses replay, we:scripts/operations/wake.mjs --resolve refuses, we:scripts/conveyor/review-referral-hold.mjs does not match, and we:scripts/lib/drain-red-team-evidence.mjs holds the run. Evidence: the operator handoff investigation note for 7629 (red team, 2026-11-28). Related #7629, #7603 REVIEW-RUN-DEAD-PENDING-JUDGE. DATA (last 7 days, loop wall time from review-job logs, loopMs; N=360 runs, minutes): accepted N=296 median 7.8 p95 25.4 max 43.9; sent back N=16 median 12.8 p95 36.3 max 39.1; parked needs-human N=45 median 12.4 p95 33.7 max 36.0; timed out at 2700000 ms N=1 as a final result (45.0; 18 logs and 39 timeout events in 7 days, most retried to a later result); other infra N=2 (under 1 min); ALL N=360 median 8.3 p95 26.4 max 45.0. Accepted runs reach 43.9 and 41.7 min, so the 45 min ceiling cuts into healthy runs, not only hangs. ASKS: (1) Prove a pending non-idempotent effect outcome from GitHub labels + comment + ledger, mark it applied or failed, then resume through the sanctioned path. No hand edit of run records (standing rule). (2) Derive the loop timeout from data: propose p95 (about 26 min) plus margin for the slowest healthy accepted runs, e.g. 60 min, with the reason written beside the key; it must live in the instant settings store as key review.loopTimeoutMs, repo default only, via we:scripts/lib/review-settings.mjs and we:scripts/lib/settings-registry.mjs, keeping the WE_REVIEW_JOB_TIMEOUT_MS minimum bound. Cross-link held card 456 SET-WAVE1 and the family 446-459. (3) A timeout must not strike between a remote write and its result record: finish or checkpoint the in-flight effect first. LIVE PROOF: PR #7629 own accepted-but-held run review-pr-pr7629-92f549da-9ab5-4cc4-8045-1be458d0de94 resolves through the product path, with before/after evidence of the run record, labels and gate.

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
