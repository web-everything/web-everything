---
kind: task
status: open
scope: ["we:scripts/conveyor/fix-procedure.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# After every fixer push, verify the PR headRefOid equals the pushed sha

A fixer push whose commit carries a token-shaped literal left PR #6719's head stale for about 8h (branch tip moved, PR head did not) while the fixer believed it had pushed (2026-11-14 05:21 ET). After every fixer push verify the PR headRefOid equals the pushed sha; on mismatch report and refuse to re-arm. The write-time guard for token-shaped literals in tests is card 8213.

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
