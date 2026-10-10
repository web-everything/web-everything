---
kind: task
parent: "xz2yynk"
status: open
blockedBy: ["xuumz76", "xt3sgtl", "xxynru6", "xh8442i"]
scope: ["we:scripts/settings/", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Fixer tasks mode on (the switch)

Slice S3t of the async-daemons epic: flip `daemonTasks.fixer.mode` to `tasks` through the cascade (logged with its source) and remove the inline path behind the setting. There is no point where tasks act without L1 (lease generation), W1 (claim hand-off) and S6a (drain honours fix claims) in place.

## Acceptance

- [A1] **Test (a)** — the daemon refuses `tasks` mode at boot unless the L1 lease generation, W1 `ownerRun` support and S6a are present (capability check).
- [A2] **Live** — `tick-timing` under 15 s for 1 hour; median decision latency under 3 min from `task-timing`; no double dispatch over 24 h (claim and run-store audit); the next rebuild smoke `reconcile-dry-run` under 60 s.

## Non-goals

- [N1] Reviewer and builder (S4, S5).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: only a settings value changes.
2. **Truncated reads** — An unreadable settings layer falls back to the standard default `inline`, logged.
3. **Shared state files** — Settings files are read-only at runtime; the flip lands by PR.
4. **Fail closed** — Missing capability -> refuse `tasks` and run `inline` with a logged reason.
5. **Identity scoping** — The mode is per daemon (`daemonTasks.fixer`); other daemons are unaffected.
6. **State over time** — Rollback is the same setting set back to `inline`.
7. **Who wrote it** — The resolved value logs which cascade layer set it.
