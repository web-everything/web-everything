---
kind: story
size: 3
parent: "xz2yynk"
status: open
blockedBy: ["xs4ewgh"]
scope: ["we:skills-src/conveyor/pass-daemon.mjs", "we:skills-src/conveyor/runner.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Each pass daemon and runner pass runs as a timed job

Slice S9 of the async-daemons epic; relates #4132 (remaining job-model adopters). we:skills-src/conveyor/pass-daemon.mjs:241 has no timeout, and we:skills-src/conveyor/runner.mjs:304-317 runs about 20 serial passes with no timeout. Each pass runs as a job on the per-item task core with a `timeoutMs` from the cascade; the daemon keeps ticking while a pass runs or is killed.

## Acceptance

- [A1] **Test (a)** — a hung pass is killed at its timeout and confirmed gone, and the daemon keeps ticking.
- [A2] **Test (b)** — kill the daemon mid-pass and restart: the pass job is reattached and not started twice.
- [A3] **Live** — one `task-timing` per pass, and a soak break killed on time.

## Non-goals

- [N1] Changing what any pass does.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: passes take no external text as input here.
2. **Truncated reads** — An unreadable pass record is reattached as unknown and confirmed by handle before any relaunch.
3. **Shared state files** — Pass records live in the job store; per-pass exclusion prevents two copies.
4. **Fail closed** — Unconfirmable pass process -> quarantined, alerted, not relaunched.
5. **Identity scoping** — Jobs keyed by `(pass, repo)`.
6. **State over time** — Timeout escalation and restart reattach covered by tests (a) and (b).
7. **Who wrote it** — Only the owning daemon resumes its pass jobs.
