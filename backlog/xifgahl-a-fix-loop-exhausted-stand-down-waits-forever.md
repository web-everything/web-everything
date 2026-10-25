---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# A "fix loop exhausted" stand-down waits forever

[held entry 336] (operator ok, held, HIGH, second) A "fix loop exhausted" stand-down waits forever. #5195 sat ~21 h (10-13 18:52 to 10-14 16:21 ET) after 4 sessions produced nothing on 7eee9db; it moved only when a ci-heal rebased it. Fix idea: before standing down, escalate once to another provider or a stronger model; after standing down, retry once automatically when main moves or after N hours (settings fixLoop.exhaustedRetry.*); then NEEDS YOU. Prove on an exhausted PR. | [held entry 337] (operator ok, held, third) No age alarm for idle PRs. Only red main has a stall alarm (#5281). Fix idea: any open PR with no owner and no activity for more than prIdle.alertHours (default 2) raises a watchdog smell, a push alert (quiet rules apply) and one diagnosis agent. Prove: an idle test PR alerts once.

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
