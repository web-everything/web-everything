---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# A paused builder must still adopt builds

[held entry 255] (session 2026-10-12, held) A paused builder must still adopt builds. The kill file skips the whole tick, and smoke-passed candidates are adopted only 'at the tick boundary', so overlay loads onto wev-control hang while paused (live: #5033 load waited 23+ min; 'SMELL tick-starved'). Pause should stop dispatch only, not adoption/self-sync. Setting-controlled. | [held entry 256] (session 2026-10-12, held) Prevention-card PRs keep opening while the builder is paused (#5029–#5034 from approval/review prevention jobs) — they add to the pile during a clog. Route them through the same pause/PR-limit as builds, or batch them into one PR per hour.

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
