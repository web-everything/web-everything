---
kind: story
size: 3
status: open
dateOpened: "2026-11-14"
tags: []
---

# Finish await-checks op: audit WEAKENED x3, remaining findings

The await-checks op (bounded wait on named PR checks, verdict success|failure|head-moved|timeout) was built with 11 passing unit tests but the canonical Codex audit returned WEAKENED three rounds running. Open findings, verbatim: (1) we:scripts/operations/await-checks.mjs:36 inherits WE_GH_READ_MEMO_DIR memoization without freshness validation; cached green evidence can certify an obsolete head and bypass head-moved detection. (2) we:scripts/operations/await-checks.mjs:36 passes only a subprocess timeout; the existing gh throttle adds admission waits and retries outside that budget, so the wait can exceed --timeout-min and tests mock this dependency away. Earlier rounds fixed: only SUCCESS passes; latest run per name; deadline recheck; queued/untimed runs pending; rank by start time then id; per-call remaining-budget timeout. The guard hook already allows we:scripts/operations/run.mjs await-checks. Live proof so far: a done PR returned its real test conclusion; no pending test run was available. The code was never pushed.

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
