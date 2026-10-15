---
bornAs: xx84y5n
kind: task
status: open
scope: ["we:scripts/conveyor/__tests__/helpers/fake-gh.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# fake-gh lock: make the ownership check and rename atomic

Ruling card from PR #5270 (operator, 2026-10-15). In we:scripts/conveyor/__tests__/helpers/fake-gh.mjs the stale-lock takeover checks ownership and then renames; a replacement lock acquired between the check and the rename can be renamed away. Test-only race; make check-and-rename atomic (or re-verify after rename) with a test that forces the interleaving.

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
