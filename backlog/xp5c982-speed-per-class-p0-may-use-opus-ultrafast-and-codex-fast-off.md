---
kind: story
size: 3
parent: "x8juafk"
status: open
blockedBy: ["xjddimd"]
scope: ["we:scripts/lib/delivery-priority-settings.json", "we:scripts/lib/dispatch-routing-policy.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-08"
tags: [conveyor, priority, routing]
---

# Speed per class: P0 may use Opus ultrafast and Codex fast, off by default, capped and logged

Slice S3c of epic x8juafk (ruling Q6: "not to be overused, but useful"). A per-class setting picks model, speed mode and executor. P0 may use Opus ultrafast (about 8x output speed, about 6x cost) for diagnosis and Codex fast (through we:scripts/codex-direct-task.mjs) for the scoped edit. P1-P4 keep today's routing.

Prep estimate: ultrafast saves about 2% of today's incident wall time and about 16% of a P0 path once detection and queue waits are fixed. So it is off by default, P0 only, and measured on each use.

## Acceptance

- [A1] **Executable** — a routing fixture: P0 with `speed.byClass.P0: ultrafast` and budget left routes to ultrafast; over the daily cap it routes to standard (never blocked); P3 never routes to ultrafast; default settings route every class as today.
- [A2] Settings: `speed.byClass` (default standard for every class), `speed.ultrafast.dailyCap`, `speed.fast.dailyCap`; invalid values fall back to standard.
- [A3] Each fast or ultrafast use logs one row: class, PR, model time, wall time, estimated time saved, spend against the cap.

## Non-goals

- [N1] Fleet-wide fast mode (rejected in the prep: about 6% gain at 6x spend).
- [N2] Changing the fixer model ladder.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: routing reads class and settings only.
2. **Truncated reads** — if today's spend cannot be read, the cap counts as reached (standard speed).
3. **Shared state files** — the spend ledger is append-only; the daily total is derived from it.
4. **Fail closed** — any invalid setting gives standard speed.
5. **Identity scoping** — the cap is per host and per day (ET).
6. **State over time** — the day boundary is America/New_York midnight, passed in as `now`.
7. **Who wrote it** — only the operator's settings file enables a fast mode.
