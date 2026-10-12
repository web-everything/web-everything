---
bornAs: x22nzem
kind: story
size: 3
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Dispatcher leases the lane and hands it to fix/ci-heal/prepare workers; review jobs never lease a PR own lane

Held finding 224 (coroner-5). 52 lane-already-leased events in 61 of 254 sessions (2026-10-09 15:42 to 10-10 20:04 ET): ci-heal 12, fix 6, prepare-item 11, other 19; e.g. ci-heal on lane-19 refused, leased by review-4777. 5 of 28 Claude prepares ended "lane N held by live lease" and were re-dispatched. Review jobs already fall back to auto-pick; workers do not. Fix: the dispatcher takes the lease at dispatch and hands it over (lane-pool adopt), refusing to name a leased lane; a read-only review job uses any free lane, never the PR own lane. Evidence: jobs cf57089e, 872b486d, ad057938, 095515ac, 5506fbff; ci-heal session 001f51be. Related #5439 (builder lane reservation).

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
