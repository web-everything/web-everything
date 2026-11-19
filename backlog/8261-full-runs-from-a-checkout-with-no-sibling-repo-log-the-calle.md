---
bornAs: xqi5rn2
kind: task
status: open
scope: ["we:scripts/readiness/remote-exec.mjs", "we:scripts/lib/remote-fallback-log.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# FULL runs from a checkout with no sibling repo: log the caller and defer instead of running locally

FULL suites fall back to the Mac from a checkout named 'repo' (sibling-inventory-failed: we:scripts/readiness/remote-exec.mjs:725-742 needs ../frontierui; with no sibling every FULL run is local; 2026-11-14 00:18 ET). Fix: (1) log ppid and session/purpose in remote-fallbacks.jsonl rows; (2) a FULL run whose remote fallback is sibling-inventory-failed is refused or deferred (R913), not run locally. Red-first tests. Card 8218 covers shipping without siblings.

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
