---
bornAs: xp16z0q
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/review-tick-promote.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A deferred replan after a stale-accept re-arm replaces the plan with an empty one and the daemon logs 'no ope…

Flow-sim gap A-C8, class K15 (detector or report false negative). Failing input: labels: 'PR X: [review:accepted] with head moved past its accept (plan row restore-review-label/stale-accept); other PRs in the repo owed reviews or parked on operator holds (review:human, stood-down, cap-exhausted)' files: 'tick 1st plan fine (RD:491 only checks plan.deferred there)' re-arm succeeds (RTP:130) and then replan(n… Cited: we:scripts/conveyor/review-tick-promote.mjs:146, we:scripts/conveyor/reconcile-pass.mjs:1705, we:scripts/conveyor/review-tick-promote.mjs:147-148, we:skills-src/conveyor/review-daemon.mjs:557-567, we:skills-src/conveyor/review-daemon.mjs:491. Soak-break sketch: wrong-clear (health watch's operator-hold-aging is told the repo has no holds) plus silent zero dispatch for that repo this tick; reconcileError stays null so the tick line does not flag LIST/RECONCILE FAILED (RD:1746). Self-heals next tick for dispatch.

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
