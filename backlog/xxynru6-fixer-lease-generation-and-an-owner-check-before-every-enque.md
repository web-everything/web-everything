---
kind: story
size: 2
parent: "xz2yynk"
status: open
scope: ["we:skills-src/conveyor/runner-lock.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Fixer lease generation and an owner check before every enqueue

Slice L1 of the async-daemons epic; the only lease change in scope. Every acquire of the fixer's runner lease (normal, expired-TTL takeover, dead-pid takeover) bumps a monotonic `generation` in the lease record. The scheduler requires `owner == me && generation == myGeneration` at tick start and again right before each enqueue; a holder paused past the 15-min TTL (e.g. SIGSTOP) then resumed fails the check and exits without enqueuing. Ticks become short, so the heartbeat stays inside the tick and stamps `lastTickCompletedAt`; the health daemon alerts when it falls behind `tickStaleAlertMs` (cascade setting). The drain lease (we:scripts/readiness/drain-lock.mjs) is a separate file and stays unchanged (R4).

## Acceptance

- [A1] **Executable** — the lease record carries `generation` (bumped on every acquire, including TTL and dead-pid takeovers) and `lastTickCompletedAt`; the scheduler checks both at tick start and before each enqueue; the health daemon alerts on a stale `lastTickCompletedAt`.
- [A2] **Crash test (a)** — SIGSTOP the holder past the TTL; a new holder acquires and the generation goes up; the old holder resumes, enqueues nothing, and exits (J2-0, J2-12).
- [A3] **Crash test (b)** — tasks of an older generation are adopted, not fenced, and their claims stay valid.
- [A4] **Crash test (c)** — a tick that wedges while the process lives: `lastTickCompletedAt` goes stale and an alert fires (J2-18).
- [A5] **Crash test (d)** — the drain lease's behaviour is byte-for-byte unchanged (J2-16).
- [A6] **Live** — the fixer log shows `gen=` across one restart, incrementing by 1.

## Non-goals

- [N1] The drain lease (R4).
- [N2] Blue-green lease transfer (sibling epic).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the lease record is written only by the daemon; no external text enters it.
2. **Truncated reads** — An unreadable or partial lease record fails the owner check, so the tick stops and enqueues nothing.
3. **Shared state files** — The lease write stays atomic under the existing runner lock; `generation` only ever increases.
4. **Fail closed** — Any failed owner/generation check stops the loop without side effects.
5. **Identity scoping** — Owner identity includes pid and process start time, so a reused pid is not the owner.
6. **State over time** — SIGSTOP past the TTL and a wedged-but-alive tick are both covered by tests (a) and (c).
7. **Who wrote it** — Only the lease holder writes the record; the drain lease file is never touched.
