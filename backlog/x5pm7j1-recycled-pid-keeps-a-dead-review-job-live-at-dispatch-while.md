---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/review-job-store.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/operations/review-job.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Recycled pid keeps a dead review job 'live' at dispatch while the planner says the PR is free

Flow-sim gap A-C1, class K1 (liveness false positive). Failing input: labels: [review:pending] files: '.operations/review-jobs/review-<N>.json = {slug, pr:N, repo, pid:P, startedAt:T0, cwd}; the job died (kill -9 or host reboot); pid P is now an unrelated live process (reused). No review verdict comment. CI green.' any daemon tick after the job died (or after a reboot) Cited: we:scripts/operations/review-job-store.mjs:107-118, we:scripts/conveyor/reconcile-pass.mjs:624-636, we:scripts/conveyor/reconcile-pass.mjs:602-612, we:scripts/conveyor/reconcile-core.mjs:1372-1382, we:skills-src/conveyor/review-daemon.mjs:677. Soak-break sketch: stuck: the PR is owed a review every tick and never dispatched while P stays alive (a system/long-lived pid can be alive indefinitely). Daemon logs only 'not dispatched - live-job' (RD:1755).

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
