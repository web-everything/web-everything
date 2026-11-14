---
kind: task
status: open
scope: ["we:scripts/operations/__tests__/fix-run-lease-lost.test.mjs", "we:scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Make two timing-based tests deterministic with a fake clock, then take them out of quarantine

Two tests count real timers and fail under load. we:scripts/operations/__tests__/fix-run-lease-lost.test.mjs 'renews our lease at least twice while spawn is pending' counts timed heartbeats; it ejected PR #6595 from the merge queue on 2026-11-13. we:scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs 'alerts once after strictly two hours per failure' failed once on main 19ab0c7758 (shard 5) and passed on rerun. Fix: use fake timers or an injected clock in both, then remove them from quarantine.

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
