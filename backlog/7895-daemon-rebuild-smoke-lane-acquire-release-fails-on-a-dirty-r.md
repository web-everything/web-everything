---
bornAs: xr0o6a5
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# daemon rebuild smoke 'lane-acquire-release' fails on a dirty REAL pool lane

HIGH priority hint. - (2026-11-01 02:31 EST) HIGH: daemon rebuild smoke 'lane-acquire-release' fails on a dirty REAL pool lane: 'lane-pool acquire --purpose=smoke failed: exited 1: lane-33: reclaiming 127 local commit(s), already patch-equivalent… (no unique content — safe to drop)' (lane-33 also has an untracked we:backlog/xhhn5sf-…md). Fix and code daemons now held on last-good for main 86eeb484 (job-daemon-rebuild-54bd7c36). Fix: smoke acquire must skip/auto-reclaim such lanes (or use its own scratch pool) instead of failing the rebuild; and acquire must not exit 1 after a 'safe to drop' reclaim.

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
