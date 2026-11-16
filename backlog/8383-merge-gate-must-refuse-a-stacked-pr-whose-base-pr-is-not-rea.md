---
bornAs: xl4svda
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-15"
tags: []
---

# Merge gate must refuse a stacked PR whose base PR is not ready

2026-11-15 14:54 ET HIGH: a stacked PR that targets main (#6891 on #6889) reached ready-to-merge while its base #6889 was red-team BLOCKED; landing it would have carried the base's blocked commits to main. The drain/merge-gate should refuse a PR whose head contains commits of another open PR that is not ready (or base stacked PRs on the parent branch). Held #6891 by draft+withdrawn.

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
