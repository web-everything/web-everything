---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/red-team-gate.mjs", "we:scripts/lib/red-team-gate-catchup.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Red-team gate must decide send-back on every new head's result

The gate skipped the send-back decision on #6774 refreshed head 8ea4e111 (advisory confirmed 1 break, no gate comment), so the PR sat ready-to-merge with red-team:blocked while the fix daemon said nothing-owed. Gate must decide on every new head's result. Owed 2026-11-14 11:45 ET.

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
