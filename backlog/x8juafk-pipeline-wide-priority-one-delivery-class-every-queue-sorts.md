---
kind: epic
parent: "5452"
status: open
relatedTo: ["5468", "5461", "5407", "5510", "5467"]
dateOpened: "2026-10-08"
tags: [conveyor, delivery-standard, priority]
---

# Pipeline-wide priority: one delivery class every queue sorts by

Trigger: the 2026-10-08 red-main incident. Main-fix PR #4522 waited in five queues (draft promote, owed-ci-rerun, lane pool, review, drain), and each queue orders work its own way: the one `urgent` flag (fix queue) means "overlay conflict", two queues are plain FIFO (heavy slots, lanes), review is newest-first, the drain goes by item number. A main fix therefore queued behind ordinary work in every line.

The model: one pure rule, `deliveryPriority(facts, settings)`, gives each PR or job a class P0-P4 plus an in-class score. Every queue sorts by class first, then by score. Its off value makes every item P3 and keeps today's order, so turning it off changes nothing. The rule and its fixtures follow card 5468's shape (pure rule over plain facts, declared settings, replay fixtures) and become a 5468 rule row.

Parent is #5452 (event-driven daemons), not the fixer epic #5467: the class is consumed by every queue (fix, review, drain, build, heavy slots, lanes), and the capacity part lands inside the decider's `admission` (#5452 E2/E4, #5461).

## Rulings (operator, 2026-10-08, all six)

- **Q1 How a class is set.** Derived from facts by one pure rule, plus an operator override (urgent -> P0, low -> P4, operator-set only). Aging: an item waiting longer than 8 h moves up one class, never into P0.
- **Q2 Order inside a class.** The fix-queue score (unblocks + time waited, in minutes) in every queue. Cost-of-delay (value / size) stays a selectable policy for later.
- **Q3 Capacity for urgent work.** A POLICY setting `reserve | interrupt`, default `interrupt` (reserve = 0). Order: queued work -> fixers parked on verify -> lowest-class active fixer (resumable). Never kill a running test. Measure how often interruption is needed (count, class, what was parked, time saved) to revisit.
- **Q4 Who may interrupt.** Only P0 (setting). P1 gets queue priority only. Revisit with the interruption log.
- **Q5 Incident mode while main is red.** Pause P3/P4 builds; the drain lands only P0 plus PRs proven green on the red main (#5118). The P0 fix skips the owed-ci-rerun and main-still-red holds and is judged only on checks main does not also fail. That merge-gate part ships LAST, behind its own tests and red-team, P0 main-fix PR only; all checks main passes must still pass.
- **Q6 Speed per class.** P0 may use Opus ultrafast (about 8x speed, 6x cost) for diagnosis and Codex fast for scoped edits. Off by default, P0 only, daily cost cap, each use logged with time saved.

## Classes

| Class | Meaning | Derived from (any one) |
|---|---|---|
| P0 incident | Repairs the delivery system itself | owns the fix for an open main-red episode; repairs a down service; operator override urgent |
| P1 unblocks others | Others wait on it | stacked base of an open change; at least one scope waiter; at least 2 open items blocked by it |
| P2 operator asked | A human is waiting | an operator answer or send-back pending action |
| P3 normal | Default | everything else |
| P4 housekeeping | Nobody waits on it | changes no code (records/docs only); operator override low |

## Slices (blockedBy DAG)

| Slice | Card | Size | Blocked by |
|---|---|---|---|
| S1 pure rule + settings + incident replay, shadow log on the fix daemon | xjddimd | 3 | - |
| S2 queues sort by class (fix, ci-heal, review, drain, draft promote, heavy waiters) | x3r5fzx | 5 | S1 |
| S3a capacity policy interrupt/reserve + interruption log | xoa99a8 | 5 | S1 (+ PR #4508) |
| S3b incident mode: class-aware builder pause, drain lands P0 + proven green | xy6r60l | 3 | S1 (+ card 5510 / PR #4527, #5118) |
| S3c speed per class, capped and logged | xp5c982 | 3 | S1 |
| S4 P0 main-fix merge-gate exemption (LAST) | xy828sf | 5 | all of the above |

## Rule for card 5468 (Review & fix policy protocol)

Row to add to 5468's rule table (5468 is held by open PRs #4508, #4502, #4461 at filing time, so the row is recorded here and added when that card is free):

| Rule | Ruling | Off value (today) | Slice |
|---|---|---|---|
| delivery priority class: one class P0-P4 per PR/job, in-class score = unblocks x weight + minutes waited, operator override, aging +1 after 8 h never into P0 | Q1, Q2 (x8juafk) | mode off: every item P3, today's order | xjddimd |

## Acceptance

- [A1] Every slice in the table above is resolved, and the S1 replay fixtures still pass with the off value reproducing today's order in every queue.
- [A2] On the next live red main, the P0 fix's wait in each line (promote, review, fix, lanes, drain) is measured before and after and reported on this epic.
- [A3] The class rule, its settings and its fixtures are linked from card 5468's rule table.

## Non-goals

- [N1] Detection of a red main and who owns it: card 5510 (PR #4527).
- [N2] Halting merges on red main: #5118. This epic only uses that signal.
- [N3] Cost-of-delay (value / size) ordering: a later selectable policy (Q2).
- [N4] CI queue ordering: no CI queue was seen in the incident.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR titles, bodies and comments never set a class; only typed facts and the operator-verified override do (S1 fixture).
2. **Truncated reads** — a missing fact counts as absent, which can only lower a class to P3, never raise it.
3. **Shared state files** — the main-red owner record (card 5510) is read-only here; S3a's interruption log is append-only.
4. **Fail closed** — an unknown or malformed setting falls back to its off value (every item P3).
5. **Identity scoping** — facts are keyed by repo and PR; the main-red owner record names repo and PR.
6. **State over time** — aging and score take `now` as an input; the owner record carries its own expiry.
7. **Who wrote it** — the override counts only when the operator set it; an unverified override is ignored and logged.
