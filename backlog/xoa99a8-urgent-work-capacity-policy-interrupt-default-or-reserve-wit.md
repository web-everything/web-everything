---
kind: story
size: 5
parent: "x8juafk"
status: open
blockedBy: ["xjddimd"]
relatedTo: ["5461"]
scope: ["we:scripts/lib/delivery-priority.mjs", "we:scripts/lib/delivery-priority-settings.json", "we:scripts/lib/dispatch-throttle.mjs", "we:scripts/lane-pool.mjs", "we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-10-08"
tags: [conveyor, priority, admission]
---

# Urgent-work capacity policy: interrupt (default) or reserve, with an interruption log

Slice S3a of epic x8juafk (rulings Q3, Q4). Capacity for urgent work is a policy setting `capacity.policy: reserve | interrupt`, default `interrupt` (reserve size 0). When a P0 cannot start for lack of a fixer slot, lane or heavy seat, it takes, in order: queued work (not yet started), then a fixer parked on verify, then the lowest-class active fixer (parked so it can resume). A running test is never killed. Only P0 may interrupt (`capacity.interruptClasses`, default `[P0]`); P1 gets queue priority only.

Every interruption appends one row to an interruption log: when, the P0 that needed room, what was parked (class, kind, PR), how long the P0 would have waited, and when the parked work resumed. That log is how reserve vs interrupt gets revisited (Q3).

Needs lane protection (PR #4508: verified unpushed work cannot be reaped) landed first. In the event-driven decider this becomes an `admission` rule (#5452 E4, #5461); until then it is one pure function the throttle, lane pool and heavy admission call.

## Acceptance

- [A1] **Executable** — a pure `admitUrgent(state, settings)` replay test: a P0 with no free slot parks queued work first, then parked-on-verify, then the lowest-class active fixer; never a running test; a P1 never interrupts.
- [A2] Policy `reserve` with size N holds N slots/lanes/seats for P0 only; policy `interrupt` with reserve 0 is the default; off value = today's (no reserve, no interruption).
- [A3] Every interruption writes one log row with the fields above; a parked fixer resumes and its row records the resume time.
- [A4] Live proof: one forced P0 on a full pool parks the right job and the log row shows it.

## Non-goals

- [N1] No change to how classes are derived (xjddimd) or how queues sort (x3r5fzx).
- [N2] P1 interruption: ruled out (Q4) until the log shows a need.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: admission reads typed state only.
2. **Truncated reads** — if the running/parked state of a job cannot be read, it is treated as running and never parked.
3. **Shared state files** — the interruption log is append-only with an atomic line write; lane and heavy markers are changed only through their own APIs.
4. **Fail closed** — an invalid policy falls back to today's (no reserve, no interruption).
5. **Identity scoping** — a parked job is named by repo, PR and session id; resume targets that exact session.
6. **State over time** — `now` is an input; a parked job left unresumed past a setting is reported.
7. **Who wrote it** — only the daemon that parked a job may resume it; the log row names that daemon.
