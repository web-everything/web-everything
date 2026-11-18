---
bornAs: x8zv6ip
kind: story
size: 3
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/check-standards.mjs"]
dateOpened: "2026-10-31"
tags: []
---

# Lane check:standards must match CI: the same 9 errors in every lane while main CI is green

Live 2026-10-31 15:25 ET: every lane reports the same 9 'npm run check:standards' errors (7 design-system themeTokens unresolved, 1 backlog graduatedTo, 1 stale we:AGENTS.md inventory) while main CI is green. Likely the lanes lack the sibling design-system/frontierui checkout or a generated file. Workers keep re-running and second-guessing. Fix: make lanes match CI (provision the sibling, or resolve tokens the way CI does).

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
