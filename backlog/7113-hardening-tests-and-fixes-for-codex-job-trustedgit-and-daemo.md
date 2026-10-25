---
bornAs: xxcyjhw
kind: task
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/codex-direct-task.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Hardening tests and fixes for codex-job trustedGit and daemon-rebuild pending-swap writes

Follow-ups from #5848/#5839 (2026-10-25): O_NOFOLLOW coverage tests for daemon-rebuild auto-rebase pending-swap writes; a base-symlink-replace coverage test and confirmation that the Apple-style system gitconfig / hooksPath / stale-base matrix tests exist for codex-job trustedGit (09:38 ET); codex-job publishes bytes changed by tests after audit (afterAll generator) - keep the first fingerprint, re-run scoped tests on final bytes and fail on change, and resolve a relative remote.origin.url against the primary repo (10:58 ET).

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
