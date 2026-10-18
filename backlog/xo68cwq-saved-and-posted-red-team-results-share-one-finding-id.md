---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-saved-red-team.mjs", "we:scripts/lib/drain-saved-red-team.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Saved and posted red-team results share one finding id

Priority: expedite (operator 2026-10-18, from PR #5551's review). In we:scripts/lib/drain-saved-red-team.mjs:58 the saved and the posted representations of the same red-team finding get different ids, so completed actions are duplicated. Give both representations one shared finding id. Acceptance: [A1] Executable - a test feeds the saved and posted forms of one finding and asserts a single id and no duplicated completed action.

## Acceptance

- [A1] **Executable** — a vitest test in we:scripts/lib/drain-saved-red-team.test.mjs feeds the saved and posted forms of the same finding and asserts one id and no duplicate completed action; fails before, passes after.

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
