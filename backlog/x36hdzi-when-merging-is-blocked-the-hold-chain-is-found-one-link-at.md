---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# When merging is blocked, the hold chain is found one link at a time

HIGH priority hint. 387. (coroner-1029, held, HIGH) When merging is blocked, the hold chain is found one link at a time. 10-29 15:18 to 20:02 ET (4 h 44 min): EACCES on /tmp/we-vitest, invalid runner context, Forge-only test failures, quarantine matched only the first red sha, area hold on quarantined tests, ghost workflow / startup_failure, routing-pinned test timeouts, multi --exclude flag rejected, stale freeze from an orchestrator rerun. About 9 links, each found only after the previous one cleared.     Fix idea: when main is red or the queue is held for more than 60 min, the drain emits ONE "unblock simulation" row that evaluates every merge hold (red-main freeze, quarantine sha match, area hold, exclude rendering, rerun staleness, workflow registration) against a main-fix PR as if main were green, and lists every hold that would still block.     Evidence: handoff 10-29 15:18-20:02 ET entries; R224-R229. Scope: we:scripts/conveyor/drain (hold evaluator), we:scripts/pr-trace. Size 5.

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
