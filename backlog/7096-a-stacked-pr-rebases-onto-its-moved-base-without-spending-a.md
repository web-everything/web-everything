---
bornAs: xj5bbkb
kind: task
status: open
scope: ["we:scripts/conveyor", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# A stacked PR rebases onto its moved base without spending a conflict-fix round

2026-10-25 00:17 ET: stacked PRs (#5881 on #5878) burn mechanical conflict-fix rounds each time the base branch moves; the 3/3 cap then parks them. Want: rebase a stacked PR onto its base automatically without counting a round, or count only conflicts versus main. Adjacent open cards 6900/6995 cover stack ordering and restack delta re-review, not the round count.

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
