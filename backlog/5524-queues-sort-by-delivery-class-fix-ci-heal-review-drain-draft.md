---
bornAs: x3r5fzx
kind: story
size: 5
parent: "5522"
status: open
blockedBy: ["5523"]
relatedTo: ["5510", "5118"]
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/operations/promote-draft-pr-dispatch.mjs", "we:scripts/lib/ci-heal-reserve.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/conveyor/delivery-priority-shadow.mjs"]
dateOpened: "2026-10-08"
tags: [conveyor, priority]
---

# Queues sort by delivery class: fix, ci-heal, review, drain, draft promote

Slice S2 of epic 5522 (rulings Q1, Q2). Each queue sorts by delivery class first, then by the fix-queue score in minutes (Q2: the same score in every queue). Off value (mode off) proven by fixture in every queue.

| Queue | Change |
|---|---|
| Fix / ci-heal rank | sort key becomes (class, then today's key); the overlay-conflict `urgent` set becomes "class P0"; P0 skips scope-overlap waits as `urgent` does now |
| ci-heal reserve | a P0 ci-heal takes the existing reserve first (no new reserve: Q3 default is interrupt, slice 5525) |
| Review | sort owed reviews by class before the free-lane cut |
| Drain | sort `ready` by class before item number; `blockedBy` stays a hard edge; a P0 that depends on a lower item lifts it to P0 (inheritance, depth-capped) |
| Heavy test slots | the waiter marker carries its class; "oldest live waiter" becomes "oldest waiter in the highest waiting class" |
| Draft promote | a P0 PR is never left as a draft |

## Acceptance

- [A1] **Executable** — each queue's test sorts a fixture queue with one P0, one P1 and P3s and puts them in class order; the same test with mode off reproduces today's order exactly.
- [A2] The override writer is checked: a priority label counts only when the operator set it (same writer check as ledger rulings); otherwise it is ignored and named in the log.
- [A3] Priority inheritance across `blockedBy` cannot loop (a cycle fixture terminates; depth capped by a setting).
- [A4] Live proof on the next red main: before/after wait per line for the P0 fix, from daemon logs.

## Non-goals

- [N1] No pre-emption, reserve or interruption (5525).
- [N2] No owed-ci-rerun or main-still-red exemption (5528, ships last).
- [N3] No build freeze (5527).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — only typed facts and the verified override set a class; PR text never does.
2. **Truncated reads** — a queue whose facts could not be read sorts that item as P3 (today's order).
3. **Shared state files** — the heavy-slot waiter marker gains a class field; old markers without it read as P3.
4. **Fail closed** — mode off or an invalid setting gives today's order in every queue.
5. **Identity scoping** — class is computed per repo and PR; a stacked base is matched by repo and branch.
6. **State over time** — the score uses `now` passed in; aging follows the S1 rule.
7. **Who wrote it** — the override label's writer is checked against the operator before it counts.
