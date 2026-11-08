---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/audit-settings.mjs", "we:scripts/lib/__tests__/audit-settings.test.mjs"]
dateOpened: "2026-11-08"
tags: []
---

# audit-settings: replace hand-listed GUARD_FLOOR with a rule-derived floor plus coverage test

Slice 2 of PR #6381 (R763, follow-up of PR #6381). The hand-listed GUARD_FLOOR in we:scripts/lib/audit-settings.mjs keeps omitting modules (recurring 'floor omits module X' class, e.g. we:scripts/lib/lane-git-hardening.mjs). Derive the floor from the rules and add a coverage test so a new guard module cannot be missed.

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
