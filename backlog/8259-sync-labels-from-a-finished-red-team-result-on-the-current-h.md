---
bornAs: xpk592o
kind: task
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:scripts/lib/red-team-result-label-sync.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Sync labels from a finished red-team result on the current head every tick

A finished 0-break red-team result on the current head never drops red-team:pending unless the review daemon hits an already-reviewed-head refusal (we:skills-src/conveyor/review-daemon.mjs:1287 to we:scripts/lib/red-team-result-label-sync.mjs:30). PR #6790 stuck pending (2026-11-14 01:41 ET). Sync result-on-head labels for any finished result on the current head each tick. Red-first test.

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

## Duplicate admission

Checked with capability-search and a backlog scan on 2026-11-14; no open card covers this exact change.
