---
bornAs: xozb05m
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/health-watch.mjs", "we:scripts/operations/operator-queue.mjs", "we:scripts/conveyor/liveness-sweep-core.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Wire the liveness sweep: --apply in the health-watch tick, notify rows into the operator queue, and the PR #5169 operator ops

The liveness sweep (we:scripts/conveyor/liveness-sweep.mjs, card 271) ships as a dry-run-by-default CLI plus the pr-no-movement smell. Still to wire: (1) run it with --apply from the health-watch tick (we:scripts/conveyor/health-watch.mjs was held by PR #5195 when this landed); (2) surface its escalated ledger rows (~/.claude/liveness-sweep/recoveries.jsonl) as operator-queue rows in we:scripts/operations/operator-queue.mjs; (3) once PR #5169 lands, point the refresh-stale-base rung in we:scripts/conveyor/liveness-sweep-core.mjs at the operator refresh op and drop its requires guard, and route pr-past-cap-fix-waiting to the grant-rounds op; (4) fix the stale-state op timing out (over 200 s) so --with-stale-state can feed the claim-holder-gone kind.

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
