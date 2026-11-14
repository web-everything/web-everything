---
kind: task
status: open
scope: ["we:scripts/operations/file-item.mjs", "we:scripts/operations/record-red-team-ruling-cli.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Tighten file-item dedupe and let the ruling CLI forward notDuplicateReason

file-item lists about 300 possible duplicate cards and aborts without --notDuplicateReason, and we:scripts/operations/record-red-team-ruling-cli.mjs cannot pass that flag, so judge card rulings fail (PR #6798, 2026-11-14 03:20 ET). Tighten the dedupe (title plus scope similarity threshold) and let the ruling CLI forward a reason.

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
