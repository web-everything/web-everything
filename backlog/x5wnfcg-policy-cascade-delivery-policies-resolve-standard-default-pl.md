---
kind: story
size: 5
status: open
scope: ["we:scripts/settings/", "we:scripts/lib/"]
dateOpened: "2026-10-09"
tags: []
---

# Policy cascade: delivery policies resolve standard default → platform preference → tool override

Operator 2026-10-09: integration strategies (serial/batched merge queue, staging, auto-revert) and every delivery policy decided this week are team practices — Ship Evermore defines them, Platform Forever holds the team preference, Longshore settings only override. Build one resolver (we:scripts/settings/) that reads tool/project override, else a platform-level preference file, else the standard default; migrate today's policies (merge-queue mode, batch size, priority classes, interrupt vs reserve, revert-red mode, quiet hours, fixer caps) to declare a standard default and a platform key. Needs prepare (where the platform preference lives before Platform Forever exists).

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
