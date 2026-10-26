---
bornAs: xqxdg8e
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Finished fixer sessions are never cleaned out of the session list

[held entry 328] (operator ok 2026-10-14 ~15:00 ET, held, low priority) Finished fixer sessions are never cleaned out of the session list. ~90 offline Remote Control rows (fix-*, ci-heal-*, prepare-item-*, back to #3311) make the system look busier than it is; only 3 bg sessions were live and idle. Fix idea: the fix and prepare dispatchers end or archive their bg session when the run settles (setting, keep N days for audit); operator status counts live sessions only. Prove: after one fix run settles, its row leaves the list.

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
