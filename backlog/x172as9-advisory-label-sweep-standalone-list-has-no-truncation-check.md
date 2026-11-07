---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/advisory-label-sweep.mjs", "we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# advisory-label sweep standalone list has no truncation check

Flow-sim gap R4-G5, class K17 (partial page read as complete). Failing input: = 200 open PRs in the repo; shared snapshot unavailable (defaultListPrs falls to its own `gh pr list --limit 200`), some PR carries a stale advisory:accepted for an old head. sweep tick. Cited: we:scripts/conveyor/advisory-label-sweep.mjs:86-96, we:scripts/conveyor/reconcile-pass.mjs:473. Soak-break sketch: stuck. The oldest open PRs (the long-parked ones, listed last) are never swept; a stale advisory label survives. Detector reports success.

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
